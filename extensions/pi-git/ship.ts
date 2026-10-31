import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { addAttention, notifyTerminals } from "./attention.ts";
import type { Config } from "./config.ts";
import { clipStart, outputOf, type Runner } from "./exec.ts";
import { repoName, repoSlug } from "./git.ts";
import type { gitPr as GitPr } from "./pr.ts";
import { type Check, rollup } from "./watch.ts";

// /ship: merge what is ready, release what the owner picks, lock the releases in the NixOS
// configuration, merge that, and wait until the host is deployed. The owner's command: it runs in the
// watcher, out of the agents' sight, and only notifies the owner when something needs them.

/** How often the flake.lock PR is made again on a newer default branch before the ship gives up. */
export const MAX_REFRESHES = 3;
/** How long one stage may wait (for CI, a release PR, a tag, a deploy) before the ship gives up on it. */
export const STAGE_TIMEOUT_MS = 90 * 60 * 1000;
const RELEASE_LABEL = "autorelease: pending";
/** Reasons that pass by themselves (or by the watcher): wait instead of failing. */
const WAITS = new Set(["checks still run", "GitHub has not decided whether it can merge", "conflicts with the base"]);

export interface ShipPr {
  number: number;
  title: string;
  sha: string;
  url: string;
}

interface Stage {
  /** When the current state started, for the timeout. */
  since: string;
  error?: string;
}

export type LibState = "merge" | "release" | "tag" | "done" | "failed";
export interface LibItem extends Stage {
  repo: string;
  /** The flake input of the NixOS configuration. */
  input: string;
  prs: ShipPr[];
  release: boolean;
  /** Whether the input needs a new lock even without a release here (an earlier release is not locked). */
  behind: boolean;
  state: LibState;
  mainSha?: string;
  tag?: string;
}

export type NixState = "libs" | "merge" | "update" | "check" | "deploy" | "done" | "failed";
export interface NixItem extends Stage {
  repo: string;
  root: string;
  prs: ShipPr[];
  state: NixState;
  inputs?: string[];
  worktree?: string;
  branch?: string;
  pr?: number;
  mergeSha?: string;
  /** How often the flake.lock PR was made again on a newer default branch, after a conflict. */
  refreshes?: number;
}

export interface Ship {
  id: string;
  host: string;
  status: "running" | "done";
  libs: LibItem[];
  nixos: NixItem;
}

export interface RepoIndex {
  repo: string;
  input?: string;
  ready: ShipPr[];
  problems: string[];
  releasePr?: { number: number; title: string };
  /** A release PR exists, or a ready PR is a feat or fix: merging leads to a release. */
  releasable: boolean;
  behind: boolean;
}

export interface ShipIndex {
  libs: RepoIndex[];
  nixos: RepoIndex & { root: string };
}

export interface ShipDeps {
  run: Runner;
  config: Config;
  gitPr: typeof GitPr;
  now?: () => Date;
  log?: (text: string) => void;
}

interface ListedPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  mergeable: string;
  reviewDecision?: string;
  statusCheckRollup?: Check[];
  headRefOid: string;
  labels?: { name: string }[];
  author?: { login: string };
}

const PR_FIELDS = "number,title,url,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefOid,labels,author";

async function gh(run: Runner, cwd: string, args: string[]): Promise<string | undefined> {
  const result = await run("gh", args, { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

async function ghJson<T>(run: Runner, cwd: string, args: string[]): Promise<T | undefined> {
  const text = await gh(run, cwd, args);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Why a PR cannot be merged now, or undefined when it can. */
export function notReady(pr: ListedPr): string | undefined {
  if (pr.isDraft) return "draft";
  if (pr.reviewDecision === "CHANGES_REQUESTED") return "changes requested";
  if (pr.mergeable === "CONFLICTING") return "conflicts with the base";
  const checks = rollup(pr.statusCheckRollup ?? []);
  if (checks === "failed") return "checks fail";
  if (checks === "pending") return "checks still run";
  if (pr.mergeable !== "MERGEABLE") return "GitHub has not decided whether it can merge";
  return undefined;
}

interface LockedInput {
  input: string;
  repo: string;
  rev: string;
}

/** The flake inputs that follow a `latest` branch on GitHub: the libraries that ship releases. */
export function latestInputs(lockText: string): LockedInput[] {
  const lock = JSON.parse(lockText) as {
    root: string;
    nodes: Record<
      string,
      {
        inputs?: Record<string, string | string[]>;
        original?: { type?: string; owner?: string; repo?: string; ref?: string };
        locked?: { rev?: string };
      }
    >;
  };
  const roots = lock.nodes[lock.root]?.inputs ?? {};
  const result: LockedInput[] = [];
  for (const [input, node] of Object.entries(roots)) {
    if (typeof node !== "string") continue;
    const entry = lock.nodes[node];
    const original = entry?.original;
    if (original?.type !== "github" || original.ref !== "latest") continue;
    result.push({ input, repo: `${original.owner}/${original.repo}`, rev: entry?.locked?.rev ?? "" });
  }
  return result.sort((a, b) => a.input.localeCompare(b.input));
}

async function indexRepo(run: Runner, cwd: string, repo: string): Promise<RepoIndex> {
  const list = await ghJson<ListedPr[]>(run, cwd, ["pr", "list", "-R", repo, "--state", "open", "--json", PR_FIELDS]);
  const index: RepoIndex = { repo, ready: [], problems: [], releasable: false, behind: false };
  if (!list) {
    index.problems.push("could not list the PRs (gh failed)");
    return index;
  }
  for (const pr of list) {
    if (pr.labels?.some((label) => label.name === RELEASE_LABEL)) {
      index.releasePr = { number: pr.number, title: pr.title };
      continue;
    }
    const why = notReady(pr);
    if (why) index.problems.push(`#${pr.number} ${pr.title}: ${why}`);
    else index.ready.push({ number: pr.number, title: pr.title, sha: pr.headRefOid, url: pr.url });
  }
  index.releasable =
    index.releasePr !== undefined || index.ready.some((pr) => /^(feat|fix)(\(.+\))?!?:/.test(pr.title));
  return index;
}

/** Everything /ship could do now, and what stands in the way. Reads only. */
export async function indexShip(run: Runner, nixosRoot: string): Promise<ShipIndex> {
  const origin = await run("git", ["remote", "get-url", "origin"], { cwd: nixosRoot });
  const nixosRepo = origin.code === 0 ? repoSlug(origin.stdout) : "";
  // The lock of GitHub's default branch, not of the checkout: that may be behind.
  await run("git", ["fetch", "origin", "--prune"], { cwd: nixosRoot });
  const shown = await run("git", ["show", "refs/remotes/origin/HEAD:flake.lock"], { cwd: nixosRoot });
  const lockText = shown.code === 0 ? shown.stdout : readFileSync(join(nixosRoot, "flake.lock"), "utf8");
  const inputs = latestInputs(lockText);
  const libs = await Promise.all(
    inputs.map(async ({ input, repo, rev }) => {
      const index = await indexRepo(run, nixosRoot, repo);
      const latest = await gh(run, nixosRoot, ["api", `repos/${repo}/commits/latest`, "--jq", ".sha"]);
      return { ...index, input, behind: latest !== undefined && latest !== rev };
    }),
  );
  const nixos = await indexRepo(run, nixosRoot, nixosRepo);
  // The NixOS configuration is not released; its merges are deployed.
  return { libs, nixos: { ...nixos, releasable: false, root: nixosRoot } };
}

/** The plan as lines for the owner: what ships, and what does not and why. */
export function planLines(index: ShipIndex): string[] {
  const lines: string[] = [];
  for (const lib of [...index.libs, index.nixos]) {
    const parts = [
      lib.ready.length > 0 ? `merge ${lib.ready.map((pr) => `#${pr.number}`).join(" ")}` : "",
      lib.releasePr
        ? `release PR #${lib.releasePr.number} (${lib.releasePr.title})`
        : lib.releasable
          ? "a release follows"
          : "",
      lib.behind ? "released, not locked yet" : "",
    ].filter(Boolean);
    lines.push(`${lib.repo}: ${parts.length > 0 ? parts.join("; ") : "nothing"}`);
    for (const problem of lib.problems) lines.push(`  not shipped: ${problem}`);
  }
  return lines;
}

/** The ship from the index and the owner's choices: which libraries release. */
export function createShip(index: ShipIndex, releases: readonly string[], host: string, now: Date): Ship {
  const since = now.toISOString();
  return {
    id: since.replace(/[:.]/g, "-"),
    host,
    status: "running",
    libs: index.libs
      .filter((lib) => lib.ready.length > 0 || releases.includes(lib.repo) || lib.behind)
      .map((lib) => ({
        repo: lib.repo,
        input: lib.input ?? repoName(lib.repo),
        prs: lib.ready,
        release: releases.includes(lib.repo),
        behind: lib.behind,
        state: "merge" as const,
        since,
      })),
    nixos: { repo: index.nixos.repo, root: index.nixos.root, prs: index.nixos.ready, state: "libs", since },
  };
}

export function shipPath(stateDir: string): string {
  return join(stateDir, "ship.json");
}

export function loadShip(stateDir: string): Ship | undefined {
  const path = shipPath(stateDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Ship;
  } catch {
    return undefined;
  }
}

export function saveShip(stateDir: string, ship: Ship): void {
  mkdirSync(stateDir, { recursive: true });
  const path = shipPath(stateDir);
  writeFileSync(`${path}.tmp`, `${JSON.stringify(ship, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/** One line per item, for /ship status and the final notification. */
export function shipLines(ship: Ship): string[] {
  const lines = ship.libs.map(
    (lib) => `${lib.repo}: ${lib.state}${lib.tag ? ` ${lib.tag}` : ""}${lib.error ? ` (${lib.error})` : ""}`,
  );
  const n = ship.nixos;
  lines.push(`${n.repo}: ${n.state}${n.pr ? ` PR #${n.pr}` : ""}${n.error ? ` (${n.error})` : ""}`);
  return lines;
}

class Shipping {
  private readonly deps: ShipDeps;
  private readonly ship: Ship;

  constructor(deps: ShipDeps, ship: Ship) {
    this.deps = deps;
    this.ship = ship;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private gh(args: string[]) {
    return gh(this.deps.run, this.ship.nixos.root, args);
  }

  private ghJson<T>(args: string[]) {
    return ghJson<T>(this.deps.run, this.ship.nixos.root, args);
  }

  private move<T extends Stage & { state: string }>(item: T, state: T["state"]): void {
    item.state = state;
    item.since = this.now().toISOString();
  }

  private timedOut(item: Stage): boolean {
    return this.now().getTime() - Date.parse(item.since) > STAGE_TIMEOUT_MS;
  }

  private async fail(item: Stage & { state: string; repo: string }, error: string): Promise<void> {
    item.state = "failed";
    item.error = error;
    const text = `pi-git ship: ${item.repo} needs you: ${error}`;
    this.deps.log?.(text);
    const { fresh } = addAttention(
      this.deps.config.stateDir,
      { kind: "watcher", repo: item.repo, text },
      `ship-${this.ship.id}`,
    );
    if (fresh) await notifyTerminals(this.deps.run, "pi-git ship", text);
  }

  /** Waits, or gives up after the stage timeout. */
  private async wait(item: Stage & { state: string; repo: string }, what: string): Promise<void> {
    if (this.timedOut(item)) await this.fail(item, `waited too long for ${what}`);
  }

  /**
   * Merge a PR when it is ready: "wait" while its checks run, GitHub decides, or it conflicts (the
   * watcher rebases PRs it follows, and an earlier merge of the same ship can cause that); an error
   * string when it cannot be merged. It merges the head it just checked.
   */
  private async mergeWhenReady(repo: string, number: number, method: string): Promise<"merged" | "wait" | string> {
    const pr = await this.ghJson<ListedPr & { state: string }>([
      "pr",
      "view",
      String(number),
      "-R",
      repo,
      "--json",
      `${PR_FIELDS},state`,
    ]);
    if (!pr) return "wait";
    if (pr.state === "MERGED") return "merged";
    if (pr.state !== "OPEN") return `#${number} is ${pr.state.toLowerCase()}`;
    const why = notReady(pr);
    if (why && WAITS.has(why)) return "wait";
    if (why) return `#${number}: ${why}`;
    const result = await this.deps.run(
      "gh",
      ["pr", "merge", String(number), "-R", repo, method, "--match-head-commit", pr.headRefOid],
      { cwd: this.ship.nixos.root },
    );
    return result.code === 0 ? "merged" : `merging #${number} failed: ${clipStart(outputOf(result).trim(), 300)}`;
  }

  /** Merge the PRs in order; false when the item has to wait or failed. */
  private async mergeAll(
    item: Stage & { state: string; repo: string },
    prs: ShipPr[],
    method: string,
  ): Promise<boolean> {
    for (const pr of prs) {
      const merged = await this.mergeWhenReady(item.repo, pr.number, method);
      if (merged === "wait") {
        await this.wait(item, `#${pr.number} to be ready`);
        return false;
      }
      if (merged !== "merged") {
        await this.fail(item, merged);
        return false;
      }
    }
    return true;
  }

  private async mergeMethod(repo: string): Promise<string> {
    const allowed = await this.ghJson<{ squash: boolean; merge: boolean }>([
      "api",
      `repos/${repo}`,
      "--jq",
      "{squash: .allow_squash_merge, merge: .allow_merge_commit}",
    ]);
    return allowed?.squash === false && allowed.merge ? "--merge" : "--squash";
  }

  async lib(item: LibItem): Promise<void> {
    if (item.state === "merge") return this.libMerge(item);
    if (item.state === "release") return this.libRelease(item);
    if (item.state === "tag") return this.libTag(item);
  }

  private async libMerge(item: LibItem): Promise<void> {
    if (!(await this.mergeAll(item, item.prs, "--squash"))) return;
    const sha = await this.gh(["api", `repos/${item.repo}/commits/HEAD`, "--jq", ".sha"]);
    if (sha) item.mainSha = sha;
    this.move(item, item.release ? "release" : "done");
  }

  private async libRelease(item: LibItem): Promise<void> {
    const runs = await this.ghJson<{ status: string; conclusion: string }[]>([
      "run",
      "list",
      "-R",
      item.repo,
      "--workflow",
      "release.yml",
      "--commit",
      item.mainSha ?? "",
      "--json",
      "status,conclusion",
    ]);
    const run = runs?.[0];
    if (run?.status !== "completed") return this.wait(item, "the release workflow");
    if (run.conclusion !== "success") return this.fail(item, `the release workflow ended with ${run.conclusion}`);
    const prs = await this.ghJson<ListedPr[]>([
      "pr",
      "list",
      "-R",
      item.repo,
      "--label",
      RELEASE_LABEL,
      "--state",
      "open",
      "--json",
      PR_FIELDS,
    ]);
    const pr = prs?.[0];
    if (!pr) return this.fail(item, "there is no release PR (no feat or fix since the last release?)");
    if (pr.mergeable === "CONFLICTING") return this.fail(item, `release PR #${pr.number}: conflicts with the base`);
    if (
      !(await this.mergeAll(
        item,
        [{ number: pr.number, title: pr.title, sha: pr.headRefOid, url: pr.url }],
        "--squash",
      ))
    )
      return;
    const version = /release (\S+)$/.exec(pr.title)?.[1];
    if (version) item.tag = version.startsWith("v") ? version : `v${version}`;
    this.move(item, "tag");
  }

  private async libTag(item: LibItem): Promise<void> {
    if (!item.tag) return this.fail(item, "the release PR title has no version");
    const tag = await this.gh(["api", `repos/${item.repo}/commits/${item.tag}`, "--jq", ".sha"]);
    const latest = await this.gh(["api", `repos/${item.repo}/commits/latest`, "--jq", ".sha"]);
    if (!tag || tag !== latest) return this.wait(item, `${item.tag} and the latest branch`);
    this.move(item, "done");
  }

  async nixos(): Promise<void> {
    const n = this.ship.nixos;
    if (n.state === "libs") return this.nixLibs(n);
    if (n.state === "merge") return this.nixMerge(n);
    if (n.state === "update") return this.nixUpdate(n);
    if (n.state === "check") return this.nixCheck(n);
    if (n.state === "deploy") return this.nixDeploy(n);
  }

  private async nixLibs(n: NixItem): Promise<void> {
    if (this.ship.libs.some((lib) => lib.state !== "done" && lib.state !== "failed")) return;
    n.inputs = this.ship.libs
      .filter((lib) => lib.state === "done" && ((lib.release && lib.tag) || lib.behind))
      .map((lib) => lib.input);
    this.move(n, "merge");
  }

  private async nixMerge(n: NixItem): Promise<void> {
    const method = await this.mergeMethod(n.repo);
    if (!(await this.mergeAll(n, n.prs, method))) return;
    if ((n.inputs ?? []).length > 0) return this.move(n, "update");
    const last = n.prs.at(-1);
    if (!last) return this.move(n, "done");
    const sha = await this.gh([
      "pr",
      "view",
      String(last.number),
      "-R",
      n.repo,
      "--json",
      "mergeCommit",
      "--jq",
      ".mergeCommit.oid",
    ]);
    if (sha) n.mergeSha = sha;
    this.move(n, "deploy");
  }

  private async git(cwd: string, args: string[], timeoutMs?: number) {
    return this.deps.run("git", args, { cwd, ...(timeoutMs ? { timeoutMs } : {}) });
  }

  /**
   * The ship's worktree of the NixOS configuration on the fresh default branch, with the inputs
   * updated: fetch, start from (or reset to) origin's default branch, nix flake update. The branch
   * holds only the ship's flake.lock change, so a reset loses nothing. A string is the error.
   */
  private async freshLock(n: NixItem): Promise<string | undefined> {
    const { config } = this.deps;
    const id = this.ship.id.slice(0, 16).toLowerCase();
    n.branch = `flake/ship-${id}`;
    n.worktree = join(config.worktrees, repoName(n.repo), `ship-${id}`);
    await this.git(n.root, ["fetch", "origin", "--prune"]);
    const head = await this.git(n.root, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
    const base = head.code === 0 ? head.stdout.trim() : "origin/main";
    const placed = existsSync(n.worktree)
      ? await this.git(n.worktree, ["reset", "--hard", base])
      : await this.git(n.root, ["worktree", "add", "--no-track", "-b", n.branch, n.worktree, base]);
    if (placed.code !== 0) return `could not put the worktree on ${base}: ${clipStart(outputOf(placed).trim(), 300)}`;
    const update = await this.deps.run("nix", ["flake", "update", ...(n.inputs ?? [])], {
      cwd: n.worktree,
      timeoutMs: config.checkTimeout * 1000,
    });
    return update.code === 0 ? undefined : `nix flake update failed: ${clipStart(outputOf(update).trim(), 300)}`;
  }

  private lockIntent(n: NixItem): string {
    const tags = this.ship.libs
      .filter((lib) => (n.inputs ?? []).includes(lib.input))
      .map((lib) => `${lib.input} ${lib.tag ?? "latest"}`);
    return `Lock the new releases in flake.lock: ${tags.join(", ")}. Only flake.lock changes; shipped with pi-git /ship.`;
  }

  private async nixUpdate(n: NixItem): Promise<void> {
    const error = await this.freshLock(n);
    if (error) return this.fail(n, error);
    const result = await this.deps.gitPr(
      { path: n.worktree as string, intent: this.lockIntent(n) },
      { run: this.deps.run, config: this.deps.config, progress: () => {} },
    );
    if (!result.ok || !result.pr) return this.fail(n, `the flake.lock PR failed: ${clipStart(result.summary, 300)}`);
    n.pr = result.pr.number;
    this.move(n, "check");
  }

  /** The default branch moved and the flake.lock PR conflicts: make it again on the fresh branch. */
  private async refresh(n: NixItem, head: string): Promise<void> {
    if ((n.refreshes ?? 0) >= MAX_REFRESHES) {
      return this.fail(n, `PR #${n.pr} still conflicts after ${MAX_REFRESHES} new locks on the default branch`);
    }
    n.refreshes = (n.refreshes ?? 0) + 1;
    const error = await this.freshLock(n);
    if (error) return this.fail(n, error);
    const result = await this.deps.gitPr(
      { path: n.worktree as string, intent: this.lockIntent(n), forceWithLease: head, updatePr: false },
      { run: this.deps.run, config: this.deps.config, progress: () => {} },
    );
    if (!result.ok) return this.fail(n, `the new flake.lock could not be pushed: ${clipStart(result.summary, 300)}`);
    this.move(n, "check");
  }

  private async nixCheck(n: NixItem): Promise<void> {
    if (n.pr === undefined) return this.fail(n, "no flake.lock PR");
    const view = await this.ghJson<{ mergeable: string; headRefOid: string; state: string }>([
      "pr",
      "view",
      String(n.pr),
      "-R",
      n.repo,
      "--json",
      "mergeable,headRefOid,state",
    ]);
    if (view?.state === "OPEN" && view.mergeable === "CONFLICTING") return this.refresh(n, view.headRefOid);
    const merged = await this.mergeWhenReady(n.repo, n.pr, await this.mergeMethod(n.repo));
    if (merged === "wait") return this.wait(n, `the checks of PR #${n.pr}`);
    if (merged !== "merged") return this.fail(n, merged);
    const sha = await this.gh([
      "pr",
      "view",
      String(n.pr),
      "-R",
      n.repo,
      "--json",
      "mergeCommit",
      "--jq",
      ".mergeCommit.oid",
    ]);
    if (!sha) return this.wait(n, `the merge commit of PR #${n.pr}`);
    n.mergeSha = sha;
    this.move(n, "deploy");
  }

  private async nixDeploy(n: NixItem): Promise<void> {
    const runs = await this.ghJson<{ name: string; status: string; conclusion: string | null }[]>([
      "api",
      `repos/${n.repo}/commits/${n.mergeSha}/check-runs`,
      "--jq",
      "[.check_runs[] | {name, status, conclusion}]",
    ]);
    const deploy = runs?.find((run) => run.name.endsWith(`deploy-${this.ship.host}`));
    if (deploy?.status !== "completed") return this.wait(n, `deploy-${this.ship.host}`);
    if (deploy.conclusion !== "success")
      return this.fail(n, `deploy-${this.ship.host} ended with ${deploy.conclusion}`);
    if (n.worktree && existsSync(n.worktree)) {
      await this.git(n.root, ["worktree", "remove", n.worktree]);
      if (n.branch) await this.git(n.root, ["branch", "-D", n.branch]);
    }
    this.move(n, "done");
  }

  async finishIfDone(): Promise<void> {
    const n = this.ship.nixos;
    if (n.state !== "done" && n.state !== "failed") return;
    this.ship.status = "done";
    const released = this.ship.libs
      .filter((lib) => lib.tag && lib.state === "done")
      .map((lib) => `${lib.repo} ${lib.tag}`);
    const failed = [...this.ship.libs, n].filter((item) => item.state === "failed").length;
    const text =
      failed === 0
        ? `pi-git ship: done. ${released.length > 0 ? `Released ${released.join(", ")}. ` : ""}${n.mergeSha ? `Deployed on ${this.ship.host}.` : "Nothing to deploy."}`
        : `pi-git ship: finished with ${failed} problem(s); /ship status shows them.`;
    this.deps.log?.(text);
    await notifyTerminals(this.deps.run, "pi-git ship", text);
  }
}

/** One round of the running ship, from the watcher: every item as far as it can go without waiting. */
export async function shipTick(deps: ShipDeps): Promise<Ship | undefined> {
  const ship = loadShip(deps.config.stateDir);
  if (ship?.status !== "running") return ship;
  const shipping = new Shipping(deps, ship);
  for (const lib of ship.libs) {
    await shipping.lib(lib);
    saveShip(deps.config.stateDir, ship);
  }
  await shipping.nixos();
  await shipping.finishIfDone();
  saveShip(deps.config.stateDir, ship);
  return ship;
}
