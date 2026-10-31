import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { addAttention, notifyTerminals } from "./attention.ts";
import type { Config } from "./config.ts";
import { clipStart, outputOf, type Runner } from "./exec.ts";
import { repoName, repoSlug } from "./git.ts";
import { askJson } from "./helper.ts";
import type { gitPr as GitPr } from "./pr.ts";
import { PREFLIGHT_PROMPT, parseVerdicts, preflightInput, simulate } from "./preflight.ts";
import { findMainCheckout } from "./start.ts";
import { addSummary, entryId, loadEntries, saveEntry } from "./state.ts";
import { gitWatch, worktreeOf } from "./status.ts";
import { type Check, rollup, stepEntry } from "./watch.ts";

// /ship: merge what is ready, release what the owner picks, lock the releases in the NixOS
// configuration, merge that, and wait until the host is deployed. The owner's command: it runs in the
// watcher, out of the agents' sight, and only notifies the owner when something needs them.

/** How often the flake.lock PR is made again on a newer default branch before the ship gives up. */
export const MAX_REFRESHES = 3;
/** How long one stage may wait (for CI, a release PR, a tag, a deploy) before the ship gives up on it. */
export const STAGE_TIMEOUT_MS = 90 * 60 * 1000;
const RELEASE_LABEL = "autorelease: pending";
/** Reasons that pass by themselves (or by the watcher): wait instead of failing. */
const WAITS = new Set(["checks still run", "GitHub has not decided whether it can merge"]);
/** Reasons the watcher can fix: /ship hands the PR to it and waits. */
const FIXABLE = new Set(["checks fail", "conflicts with the base"]);
/** Reasons only the owner can solve: the PR stays out of the ship. */
const OWNER = new Set(["draft", "changes requested"]);
const RELEASING = /^(feat|fix)(\(.+\))?!?:/;

export interface ShipPr {
  number: number;
  title: string;
  sha: string;
  url: string;
  /** Not ready yet when indexed: it waits for its checks, or the watcher fixes it first. */
  note?: string;
  /** The PR's base when it is not the default branch: stacked, merged after its base. */
  stackedOn?: string;
  /** The PR's branch, so stacked PRs find the PR they build on. */
  branch?: string;
  /** Merged by the ship. */
  merged?: boolean;
  /** Why the ship gave up on this PR; the other PRs go on. */
  error?: string;
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
  /** PRs whose title gets a releasing type, so their merge leads to a release. */
  retitle?: number[];
  /** The type for `retitle`: feat or fix, as the reviewing agent decided. */
  retitleType?: "feat" | "fix";
  /** PRs without a feat or fix: the reviewing agent decides whether they release. */
  review?: number[];
  /** A release PR was waiting when the ship started. */
  releasePr?: number;
  /** PRs handed to the watcher to fix (red checks, conflicts). */
  adopted?: number[];
  /** Not a flake input of the configuration: released, but nothing to lock. */
  outside?: boolean;
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
  adopted?: number[];
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
  /** The pi session that started the ship: its agent gets the result in the history. */
  sessionId?: string;
  /** PRs the preflight left out, with the reason, for /ship status. */
  skipped?: string[];
  /** The reviewing agent decided the releases of the libraries in `review`. */
  reviewed?: boolean;
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
  /** PRs ship merges, but none leads to a release (docs, chore, ...): the owner may make one a feat. */
  noRelease?: number;
  /** A repository with releases that the NixOS configuration does not use yet: released, not deployed. */
  outside?: boolean;
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
  /** Hands a PR to the watcher (quietly); a string is why not. Default: a worktree on its branch, then git_watch. */
  watchPr?: (repo: string, number: number) => Promise<string | undefined>;
  /** The preflight of one repository: the PRs to skip, with the reason. Default: simulate, then the agent. */
  preflight?: (repo: string, prs: ShipPr[]) => Promise<Preflight>;
  /** Starts the watcher's fix of a queued PR at once, in the background. Default: stepEntry. */
  fixNow?: (repo: string, number: number) => void;
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
  baseRefName?: string;
  headRefName?: string;
}

const PR_FIELDS =
  "number,title,url,isDraft,mergeable,reviewDecision,statusCheckRollup,headRefOid,labels,author,baseRefName,headRefName";
/** GitHub refuses a merge while the branch moves under it: wait and try again. */
const MOVED = /Head branch was modified|Base branch was modified|is not mergeable|try the merge again/i;

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

function addListedPr(index: RepoIndex, pr: ListedPr, defaultBranch: string): void {
  if (pr.labels?.some((label) => label.name === RELEASE_LABEL)) {
    index.releasePr = { number: pr.number, title: pr.title };
    return;
  }
  const why = notReady(pr);
  if (why && OWNER.has(why)) {
    index.problems.push(`#${pr.number} ${pr.title}: ${why}`);
    return;
  }
  const stacked = pr.baseRefName !== undefined && pr.baseRefName !== defaultBranch ? pr.baseRefName : undefined;
  const note = stacked
    ? `stacked on ${stacked}: after it`
    : why === undefined
      ? undefined
      : FIXABLE.has(why)
        ? `the watcher fixes it: ${why}`
        : "waits for its checks";
  index.ready.push({
    number: pr.number,
    title: pr.title,
    sha: pr.headRefOid,
    url: pr.url,
    ...(note ? { note } : {}),
    ...(stacked ? { stackedOn: stacked } : {}),
    ...(pr.headRefName ? { branch: pr.headRefName } : {}),
  });
}

async function indexRepo(run: Runner, cwd: string, repo: string): Promise<RepoIndex> {
  const list = await ghJson<ListedPr[]>(run, cwd, ["pr", "list", "-R", repo, "--state", "open", "--json", PR_FIELDS]);
  const index: RepoIndex = { repo, ready: [], problems: [], releasable: false, behind: false };
  if (!list) {
    index.problems.push("could not list the PRs (gh failed)");
    return index;
  }
  const defaultBranch =
    (await gh(run, cwd, ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"])) ??
    "main";
  const sorted = [...list].sort((a, b) => a.number - b.number);
  for (const pr of sorted) addListedPr(index, pr, defaultBranch);
  index.ready = stackOrder(index.ready).order;
  index.releasable = index.releasePr !== undefined || index.ready.some((pr) => RELEASING.test(pr.title));
  const first = index.ready[0];
  if (!index.releasable && first) index.noRelease = first.number;
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
  const outside = await outsideRepos(run, nixosRoot, nixosRepo, new Set(inputs.map((item) => item.repo.toLowerCase())));
  const nixos = await indexRepo(run, nixosRoot, nixosRepo);
  // The NixOS configuration is not released; its merges are deployed.
  const { noRelease: _none, ...plain } = nixos;
  return { libs: [...libs, ...outside], nixos: { ...plain, releasable: false, root: nixosRoot } };
}

/**
 * The owner's other repositories with release-please that the configuration does not use yet: their
 * PRs and releases ship too, and the plan says they are not in NixOS (adding them changes the
 * configuration, so /ship does not).
 */
async function outsideRepos(run: Runner, cwd: string, nixosRepo: string, known: Set<string>): Promise<RepoIndex[]> {
  const owner = nixosRepo.split("/")[0];
  if (!owner) return [];
  const list = await ghJson<{ nameWithOwner: string }[]>(run, cwd, [
    "repo",
    "list",
    owner,
    "--no-archived",
    "--source",
    "--limit",
    "500",
    "--json",
    "nameWithOwner",
  ]);
  const candidates = (list ?? [])
    .map((repo) => repo.nameWithOwner)
    .filter((repo) => repo.toLowerCase() !== nixosRepo.toLowerCase() && !known.has(repo.toLowerCase()));
  const found = await Promise.all(
    candidates.map(async (repo) =>
      (await gh(run, cwd, ["api", `repos/${repo}/contents/release-please-config.json`, "--jq", ".name"]))
        ? repo
        : undefined,
    ),
  );
  return Promise.all(
    found
      .filter((repo): repo is string => repo !== undefined)
      .sort()
      .map(async (repo) => ({ ...(await indexRepo(run, cwd, repo)), outside: true })),
  );
}

/** The PR a stacked PR builds on: the one whose branch is its base. */
export function stackBase(prs: readonly ShipPr[], pr: ShipPr): ShipPr | undefined {
  return pr.stackedOn === undefined ? undefined : prs.find((other) => other.branch === pr.stackedOn);
}

/**
 * The order to merge in: oldest first, and every stacked PR right after the PR it builds on (also
 * stacks of more than two). Orphans are stacked PRs whose base PR is not in the list.
 */
export function stackOrder(prs: readonly ShipPr[]): { order: ShipPr[]; orphans: ShipPr[] } {
  const byNumber = [...prs].sort((a, b) => a.number - b.number);
  const order: ShipPr[] = [];
  const visit = (pr: ShipPr) => {
    order.push(pr);
    for (const child of byNumber.filter((other) => stackBase(byNumber, other) === pr)) visit(child);
  };
  for (const root of byNumber.filter((pr) => pr.stackedOn === undefined)) visit(root);
  const orphans = byNumber.filter((pr) => !order.includes(pr));
  return { order: [...order, ...orphans], orphans };
}

/** The plan as lines for the owner: what ships, and what does not and why. */
function planLinesForRepo(lib: RepoIndex): string[] {
  const parts = [
    lib.ready.length > 0
      ? `merge ${lib.ready.map((pr) => `#${pr.number}${pr.note ? ` (${pr.note})` : ""}`).join(", ")}`
      : "",
    lib.noRelease !== undefined ? "no release follows (no feat or fix)" : "",
    lib.outside ? "not in the NixOS configuration yet: released, not deployed" : "",
    lib.releasePr
      ? `release PR #${lib.releasePr.number} (${lib.releasePr.title})`
      : lib.releasable
        ? "a release follows"
        : "",
    lib.behind ? "released, not locked yet" : "",
  ].filter(Boolean);
  return [
    `${lib.repo}: ${parts.join("; ") || "nothing"}`,
    ...lib.problems.map((problem) => `  not shipped: ${problem}`),
  ];
}

export function planLines(index: ShipIndex): string[] {
  return [...index.libs, index.nixos].flatMap(planLinesForRepo);
}

/** The ship from the index and the owner's choices: which libraries release. */
export function createShip(
  index: ShipIndex,
  releases: readonly string[],
  host: string,
  now: Date,
  retitles: Readonly<Record<string, number>> = {},
): Ship {
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
        ...(lib.outside ? { outside: true } : {}),
        ...(lib.releasePr ? { releasePr: lib.releasePr.number } : {}),
        prs: lib.ready,
        release: releases.includes(lib.repo),
        ...(retitles[lib.repo] !== undefined ? { retitle: [retitles[lib.repo] as number] } : {}),
        ...(lib.noRelease !== undefined && retitles[lib.repo] === undefined
          ? { review: lib.ready.map((pr) => pr.number) }
          : {}),
        behind: lib.behind,
        state: "merge" as const,
        since,
      })),
    nixos: { repo: index.nixos.repo, root: index.nixos.root, prs: index.nixos.ready, state: "merge", since },
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
  for (const line of ship.skipped ?? []) lines.push(`  not shipped: ${line}`);
  return lines;
}

/** A worktree on the PR's branch (made when missing), then quietly watched; a string is why not. */
export async function watchPr(
  deps: ShipDeps,
  sessionId: string,
  repo: string,
  number: number,
): Promise<string | undefined> {
  const tools = { run: deps.run, config: deps.config, home: homedir(), progress: () => {} };
  const main = await findMainCheckout(tools, repo);
  if (typeof main !== "string") return main.error;
  const branch = await gh(deps.run, main, [
    "pr",
    "view",
    String(number),
    "-R",
    repo,
    "--json",
    "headRefName",
    "--jq",
    ".headRefName",
  ]);
  if (!branch) return "gh could not read the branch";
  if (!(await worktreeOf(deps.run, main, branch))) {
    const dir = join(deps.config.worktrees, repoName(repo), branch.replace(/^[^/]+\//, "").replace(/\//g, "-"));
    await deps.run("git", ["fetch", "origin", branch], { cwd: main });
    const added = await deps.run("git", ["worktree", "add", "--track", "-b", branch, dir, `origin/${branch}`], {
      cwd: main,
    });
    if (added.code !== 0) return `no worktree: ${clipStart(outputOf(added).trim(), 200)}`;
  }
  const watched = await gitWatch(tools, { pr: String(number), path: main, sessionId, quiet: true });
  return watched.ok ? undefined : watched.summary;
}

interface ReleaseDecision {
  release: boolean;
  pr?: number;
  type?: "feat" | "fix";
  reason: string;
}

function parseDecision(value: unknown): ReleaseDecision | Error {
  if (typeof value !== "object" || value === null) return new Error("expected an object");
  const v = value as Record<string, unknown>;
  if (typeof v.release !== "boolean") return new Error('"release" must be true or false');
  if (v.release && (typeof v.pr !== "number" || (v.type !== "feat" && v.type !== "fix"))) {
    return new Error('a release needs "pr" (a number) and "type" (feat or fix)');
  }
  return {
    release: v.release,
    ...(typeof v.pr === "number" ? { pr: v.pr } : {}),
    ...(v.type === "feat" || v.type === "fix" ? { type: v.type } : {}),
    reason: typeof v.reason === "string" ? v.reason : "",
  };
}

export const RELEASE_PROMPT = [
  "You decide for pi-git /ship whether merged changes of a repository should be released.",
  "The input has the open PRs that will be merged, with title, body and changed files; none is titled feat or fix,",
  "so no release would follow on its own.",
  "",
  "Release when users of the repository get something different: code, behavior, configuration, a skill or",
  "prompt that is shipped, or documentation that is part of the package. Do not release for CI, repository",
  "tooling, tests only, or internal notes.",
  "",
  'Answer with JSON only: {"release": true, "pr": <number of the PR to retitle>, "type": "feat" | "fix",',
  '"reason": "<one sentence>"} or {"release": false, "reason": "<one sentence>"}.',
].join("\n");

/** The preflight of one repository: the PRs to leave out, and the order in which the rest lands. */
export interface Preflight {
  skips: { pr: number; reason: string }[];
  /** PR numbers in the order they land: clean ones first, conflicting ones last. */
  order?: number[] | undefined;
}

/** PRs whose fix runs now, so a ship round does not start a second one. */
const FIXING = new Set<string>();

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
    if (fresh) {
      await notifyTerminals(this.deps.run, "pi-git ship", text);
      this.tellAgent("failed", text, item.repo);
    }
  }

  /** A problem with one PR: the owner and the agent hear of it; the rest of the ship goes on. */
  private async problem(repo: string, error: string): Promise<void> {
    const text = `pi-git ship: ${repo} needs you: ${error}`;
    this.deps.log?.(text);
    const { fresh } = addAttention(
      this.deps.config.stateDir,
      { kind: "watcher", repo, text },
      `ship-${this.ship.id}-${error}`,
    );
    if (fresh) {
      await notifyTerminals(this.deps.run, "pi-git ship", text);
      this.tellAgent("failed", text, `${repo}-${error.slice(0, 20)}`);
    }
  }

  /** Put a message into the history of the agent that started the ship (or of the next session there). */
  private tellAgent(status: "merged" | "failed", text: string, part: string): void {
    addSummary(this.deps.config.stateDir, {
      entryId: `ship-${this.ship.id}-${part.replace(/[^A-Za-z0-9._-]/g, "_")}`,
      repo: this.ship.nixos.repo,
      number: 0,
      sessionId: this.ship.sessionId ?? "",
      status,
      text,
      created: this.now().toISOString(),
    });
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
  private async mergeWhenReady(
    repo: string,
    number: number,
    method: string,
    item?: { adopted?: number[] },
  ): Promise<"merged" | "wait" | string> {
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
    // Never merge into another PR's branch: wait until its base is merged and GitHub moves it.
    if (pr.baseRefName && pr.baseRefName !== (await this.defaultBranch(repo))) return "wait";
    const why = notReady(pr);
    if (why && WAITS.has(why)) return "wait";
    if (why && FIXABLE.has(why) && item) return this.handToWatcher(item, repo, pr, why);
    if (why) return `#${number}: ${why}`;
    const result = await this.deps.run(
      "gh",
      ["pr", "merge", String(number), "-R", repo, method, "--match-head-commit", pr.headRefOid],
      { cwd: this.ship.nixos.root },
    );
    if (result.code === 0) return "merged";
    if (MOVED.test(outputOf(result))) return "wait";
    return `merging #${number} failed: ${clipStart(outputOf(result).trim(), 300)}`;
  }

  private readonly defaults = new Map<string, string>();

  private async defaultBranch(repo: string): Promise<string> {
    if (!this.defaults.has(repo)) {
      const name = await this.gh([
        "repo",
        "view",
        repo,
        "--json",
        "defaultBranchRef",
        "--jq",
        ".defaultBranchRef.name",
      ]);
      this.defaults.set(repo, name ?? "main");
    }
    return this.defaults.get(repo) as string;
  }

  /**
   * A PR with red checks or a conflict: hand it to the watcher once (a worktree on its branch, then
   * quietly watched), and wait. When the watcher gave up and the PR is still red, it fails.
   */
  private async handToWatcher(item: { adopted?: number[] }, repo: string, pr: ListedPr, why: string): Promise<string> {
    if (item.adopted?.includes(pr.number)) {
      const watched = loadEntries(this.deps.config.stateDir).some((entry) => entry.id === entryId(repo, pr.number));
      if (!watched) return `#${pr.number}: ${why}, and the watcher could not fix it`;
      this.fixNow(repo, pr.number);
      return "wait";
    }
    const error = await (this.deps.watchPr ?? ((r, n) => watchPr(this.deps, `ship-${this.ship.id}`, r, n)))(
      repo,
      pr.number,
    );
    if (error) return `#${pr.number}: ${why}; ${error}`;
    item.adopted = [...(item.adopted ?? []), pr.number];
    this.fixNow(repo, pr.number);
    return "wait";
  }

  /** Start the fix of a red or conflicting PR at once, beside everything else; once at a time per PR. */
  private fixNow(repo: string, number: number): void {
    if (this.deps.fixNow) {
      this.deps.fixNow(repo, number);
      return;
    }
    const entry = loadEntries(this.deps.config.stateDir).find((item) => item.id === entryId(repo, number));
    if (!entry || FIXING.has(entry.id)) return;
    FIXING.add(entry.id);
    void stepEntry(this.deps, entry).finally(() => FIXING.delete(entry.id));
  }

  /**
   * Every PR, oldest first, each round: green ones are merged, red or conflicting ones are being
   * fixed (each by its own helper, at the same time), the rest waits. One PR the ship gives up on
   * does not stop the others. True when every PR is merged or given up.
   */
  private async mergeAll(
    item: Stage & { state: string; repo: string },
    prs: ShipPr[],
    method: string,
  ): Promise<boolean> {
    let waiting: number | undefined;
    for (const pr of prs) {
      if (pr.merged || pr.error) continue;
      const merged = await this.mergeWhenReady(item.repo, pr.number, method, item as { adopted?: number[] });
      if (merged === "merged") pr.merged = true;
      else if (merged === "wait") waiting ??= pr.number;
      else {
        pr.error = merged;
        await this.problem(item.repo, merged);
      }
    }
    if (waiting === undefined) return true;
    await this.wait(item, `#${waiting} to be ready`);
    return false;
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

  /** The reviewing agent decides per library without a feat or fix whether it releases; no questions. */
  async review(): Promise<void> {
    const { config } = this.deps;
    const agent = { ...config, model: config.shipModel, thinking: config.shipThinking, skill: undefined };
    // First the preflight of every repository at the same time, then the releases of what is left.
    const skipped = (
      await Promise.all([
        ...this.ship.libs.map((lib) => this.skipFrom(lib.repo, lib.prs, agent)),
        this.skipFrom(this.ship.nixos.repo, this.ship.nixos.prs, agent),
      ])
    ).flat();
    for (const lib of this.ship.libs) {
      // Every PR that would have released was skipped, and no release PR waits: nothing to release.
      if (lib.release && !lib.releasePr && !lib.prs.some((pr) => RELEASING.test(pr.title)) && !lib.retitle) {
        lib.release = false;
      }
      lib.review = (lib.review ?? []).filter((n) => lib.prs.some((pr) => pr.number === n));
    }
    await Promise.all([...this.ship.libs, this.ship.nixos].map((item) => this.adoptStacks(item)));
    if (skipped.length > 0) {
      const text = `pi-git ship: not shipped, they need you:\n${skipped.map((line) => `- ${line}`).join("\n")}`;
      this.deps.log?.(text);
      await notifyTerminals(this.deps.run, "pi-git ship", `${skipped.length} PR(s) not shipped; /ship status`);
      this.tellAgent("merged", text, "preflight");
      this.ship.skipped = skipped;
    }
    for (const item of this.ship.libs) {
      if ((item.review ?? []).length === 0) continue;
      await this.reviewLibrary(item, agent);
    }
    this.ship.reviewed = true;
  }

  /**
   * Simulate the merges of one repository, and let the agent decide ship, fix or skip, when anything
   * is not plainly clean and green. Skipped PRs leave the ship; returns them as lines for the owner.
   */
  /** Take the PRs the preflight skips out of the ship; returns them as lines for the owner. */
  private async skipFrom(repo: string, prs: ShipPr[], agent: Config): Promise<string[]> {
    if (prs.length === 0) return [];
    const lines: string[] = [];
    const drop = (number: number, reason: string) => {
      const index = prs.findIndex((pr) => pr.number === number);
      if (index < 0) return;
      const [pr] = prs.splice(index, 1);
      lines.push(`${repo}#${number} ${pr?.title ?? ""}: ${reason}`);
    };
    // A stacked PR whose base PR is not shipped cannot be shipped either; also down a stack.
    const orphans = () => stackOrder(prs).orphans;
    for (let round = orphans(); round.length > 0; round = orphans()) {
      for (const pr of round) drop(pr.number, `stacked on ${pr.stackedOn}, whose PR is not shipped`);
    }
    const { skips, order } = await (this.deps.preflight ?? ((r, p) => this.preflight(r, p, agent)))(repo, prs);
    for (const skip of skips) drop(skip.pr, skip.reason);
    // Merge in the order the simulation found; PRs it did not see keep their place at the end.
    if (order) {
      const rank = (pr: ShipPr) => (order.includes(pr.number) ? order.indexOf(pr.number) : order.length);
      prs.sort((a, b) => rank(a) - rank(b));
    }
    for (let round = orphans(); round.length > 0; round = orphans()) {
      for (const pr of round) drop(pr.number, `stacked on ${pr.stackedOn}, whose PR is not shipped`);
    }
    return lines;
  }

  /**
   * Stacked PRs go to the watcher before their base merges (quietly, with their current base), so
   * when GitHub moves one to the default branch the watcher rebases only its own commits at once.
   */
  private async adoptStacks(item: { repo: string; prs: ShipPr[]; adopted?: number[] }): Promise<void> {
    for (const pr of item.prs.filter((entry) => entry.stackedOn && !item.adopted?.includes(entry.number))) {
      const error = await (this.deps.watchPr ?? ((r, n) => watchPr(this.deps, `ship-${this.ship.id}`, r, n)))(
        item.repo,
        pr.number,
      );
      if (error) {
        this.deps.log?.(`pi-git ship: ${item.repo}#${pr.number}: not watched (${error}); it waits for its base`);
        continue;
      }
      item.adopted = [...(item.adopted ?? []), pr.number];
    }
  }

  private async preflight(repo: string, prs: ShipPr[], agent: Config): Promise<Preflight> {
    const tools = { run: this.deps.run, config: this.deps.config, home: homedir(), progress: () => {} };
    const main = await findMainCheckout(tools, repo);
    const base = await this.defaultBranch(repo);
    const items = (after: Record<number, number[]> = {}) =>
      stackOrder(prs).order.map((pr) => ({
        number: pr.number,
        onto: stackBase(prs, pr)?.number,
        after: after[pr.number],
      }));
    const run = (after?: Record<number, number[]>) =>
      typeof main === "string"
        ? simulate(this.deps.run, main, base, items(after))
        : Promise.resolve(`no local checkout (${main.error})`);
    let simulated = await run();
    const order = () => (typeof simulated === "string" ? undefined : simulated.map((item) => item.number));
    const plain = typeof simulated !== "string" && simulated.every((item) => item.clean) && prs.every((pr) => !pr.note);
    if (plain) return { skips: [], order: order() };
    const withBodies = await Promise.all(
      prs.map(async (pr) => ({
        ...pr,
        body: (await this.gh(["pr", "view", String(pr.number), "-R", repo, "--json", "body", "--jq", ".body"])) ?? "",
      })),
    );
    const verdicts = await askJson(
      this.deps.run,
      agent,
      { cwd: this.ship.nixos.root, prompt: PREFLIGHT_PROMPT, input: preflightInput(repo, withBodies, simulated) },
      parseVerdicts(prs.map((pr) => pr.number)),
    );
    if (verdicts instanceof Error) {
      this.deps.log?.(
        `pi-git ship: ${repo}: no preflight verdicts (${verdicts.message}); merging in the simulated order`,
      );
      return { skips: [], order: order() };
    }
    // PRs that use what another adds land after it: find the order again with those needs.
    const after = Object.fromEntries(verdicts.filter((v) => v.after).map((v) => [v.pr, v.after as number[]]));
    if (Object.keys(after).length > 0) simulated = await run(after);
    return {
      skips: verdicts.filter((item) => item.action === "skip").map((item) => ({ pr: item.pr, reason: item.reason })),
      order: order(),
    };
  }

  private async reviewLibrary(
    item: LibItem,
    agent: Omit<Config, "model" | "thinking" | "skill"> & { model: string; thinking: string; skill: undefined },
  ): Promise<void> {
    const prs: string[] = [];
    for (const number of item.review ?? []) {
      const view = await this.gh(["pr", "view", String(number), "-R", item.repo, "--json", "number,title,body,files"]);
      if (view) prs.push(clipStart(view, 6000));
    }
    const decision = await askJson(
      this.deps.run,
      agent,
      {
        cwd: this.ship.nixos.root,
        prompt: RELEASE_PROMPT,
        input: `Repository: ${item.repo}\n\n${prs.join("\n\n")}`,
      },
      parseDecision,
    );
    if (decision instanceof Error) {
      this.deps.log?.(`pi-git ship: ${item.repo}: no release decision (${decision.message}); not released`);
      return;
    }
    this.deps.log?.(`pi-git ship: ${item.repo}: ${decision.release ? "release" : "no release"}: ${decision.reason}`);
    if (!decision.release || decision.pr === undefined || !(item.review ?? []).includes(decision.pr)) return;
    item.release = true;
    item.retitle = [decision.pr];
    item.retitleType = decision.type ?? "feat";
  }

  async lib(item: LibItem): Promise<void> {
    if (item.state === "merge") return this.libMerge(item);
    if (item.state === "release") return this.libRelease(item);
    if (item.state === "tag") return this.libTag(item);
  }

  private async libMerge(item: LibItem): Promise<void> {
    const retitled = await this.retitle(item);
    if (retitled) return this.fail(item, retitled);
    if (!(await this.mergeAll(item, item.prs, "--squash"))) return;
    const sha = await this.gh(["api", `repos/${item.repo}/commits/HEAD`, "--jq", ".sha"]);
    if (sha) item.mainSha = sha;
    this.move(item, item.release ? "release" : "done");
  }

  /** Make the chosen PRs a feat, so the merge leads to a release; a string is the error. */
  private async retitle(item: LibItem): Promise<string | undefined> {
    for (const number of item.retitle ?? []) {
      const pr = item.prs.find((entry) => entry.number === number);
      if (!pr || RELEASING.test(pr.title)) continue;
      const title = pr.title.replace(/^[a-z]+/, item.retitleType ?? "feat");
      const edited = await this.deps.run("gh", ["pr", "edit", String(number), "-R", item.repo, "--title", title], {
        cwd: this.ship.nixos.root,
      });
      if (edited.code !== 0) return `could not retitle #${number}: ${clipStart(outputOf(edited).trim(), 200)}`;
      pr.title = title;
    }
    return undefined;
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

  /** The configuration's own PRs do not wait for the libraries: merged at once. */
  private async nixMerge(n: NixItem): Promise<void> {
    const method = await this.mergeMethod(n.repo);
    if (!(await this.mergeAll(n, n.prs, method))) return;
    this.move(n, "libs");
  }

  /** Once every library is done or failed: lock the releases, or deploy the merged PRs, or nothing. */
  private async nixLibs(n: NixItem): Promise<void> {
    if (this.ship.libs.some((lib) => lib.state !== "done" && lib.state !== "failed")) return;
    n.inputs = this.ship.libs
      .filter((lib) => !lib.outside && lib.state === "done" && ((lib.release && lib.tag) || lib.behind))
      .map((lib) => lib.input);
    if (n.inputs.length > 0) return this.move(n, "update");
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

  /** The flake.lock commit and PR title, in the style of the configuration: no helper needed. */
  private lockTitle(n: NixItem): string {
    const tags = this.ship.libs
      .filter((lib) => (n.inputs ?? []).includes(lib.input))
      .map((lib) => `${lib.input} ${lib.tag ?? "latest"}`);
    return `flake: lock ${tags.join(", ")}`;
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
      { path: n.worktree as string, intent: this.lockIntent(n), title: this.lockTitle(n) },
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
      {
        path: n.worktree as string,
        intent: this.lockIntent(n),
        title: this.lockTitle(n),
        forceWithLease: head,
        updatePr: false,
      },
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
    // Problems were told one by one; the end goes into the history once, quietly.
    this.tellAgent("merged", text, "end");
  }
}

/**
 * The ship takes over the PRs it merges: the watcher keeps fixing them, but stops reporting them to
 * the sessions that made them. Only the ship's end (and its problems) is reported.
 */
export function quietWatched(stateDir: string, ship: Ship): void {
  const shipped = new Set([
    ...ship.libs.flatMap((lib) => lib.prs.map((pr) => entryId(lib.repo, pr.number))),
    ...ship.nixos.prs.map((pr) => entryId(ship.nixos.repo, pr.number)),
  ]);
  for (const entry of loadEntries(stateDir)) {
    if (shipped.has(entry.id) && !entry.quiet) saveEntry(stateDir, { ...entry, quiet: true });
  }
}

/** Passes per round: each moves every part as far as it can; a round stops early when nothing moved. */
export const MAX_PASSES = 8;

/**
 * One round of the running ship, from the watcher. The libraries and the configuration move at the
 * same time (they do not depend on each other until the flake.lock update), and a round keeps going
 * while something moves, so nothing waits for the next round without a reason.
 */
export async function shipTick(deps: ShipDeps, passes = MAX_PASSES): Promise<Ship | undefined> {
  const ship = loadShip(deps.config.stateDir);
  if (ship?.status !== "running") return ship;
  const shipping = new Shipping(deps, ship);
  quietWatched(deps.config.stateDir, ship);
  if (!ship.reviewed) {
    await shipping.review();
    saveShip(deps.config.stateDir, ship);
  }
  for (let pass = 0; pass < passes && ship.status === "running"; pass++) {
    const before = JSON.stringify(ship);
    // The configuration merges its own PRs at the same time as the libraries; its later steps look
    // at the libraries, so they come after them in the pass.
    const nixFirst = ship.nixos.state === "merge";
    await Promise.all([...ship.libs.map((lib) => shipping.lib(lib)), ...(nixFirst ? [shipping.nixos()] : [])]);
    if (!nixFirst) await shipping.nixos();
    await shipping.finishIfDone();
    saveShip(deps.config.stateDir, ship);
    if (JSON.stringify(ship) === before) break;
  }
  return ship;
}
