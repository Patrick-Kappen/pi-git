import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clipEnd, outputOf, type Runner } from "./exec.ts";
import { runHelper } from "./helper.ts";
import type { gitPr as GitPr } from "./pr.ts";
import { ciFixPrompt, conflictPrompt } from "./prompts.ts";
import { addSummary, type Entry, type FinalStatus, loadEntries, lock, removeEntry, saveEntry } from "./state.ts";

/** gh's view of a PR, as far as the watcher needs it. */
export interface PrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefOid: string;
  statusCheckRollup: Check[];
}

/** A check run (GitHub Actions and apps) or a commit status (bots such as a build server). */
export interface Check {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
  description?: string;
}

export type CheckState = "pending" | "failed" | "passed";

const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
/** Waiting for someone, not for the helper: an approval, or a check that has not started. */
const WAITING = new Set(["ACTION_REQUIRED", "PENDING", "EXPECTED", "QUEUED", "IN_PROGRESS", "WAITING", "REQUESTED"]);

export function checkState(check: Check): CheckState {
  if (check.__typename === "StatusContext" || (check.state !== undefined && check.status === undefined)) {
    if (check.state === "SUCCESS") return "passed";
    return WAITING.has(check.state ?? "") ? "pending" : "failed";
  }
  if (check.status !== "COMPLETED") return "pending";
  if (PASSED.has(check.conclusion ?? "")) return "passed";
  return WAITING.has(check.conclusion ?? "") ? "pending" : "failed";
}

export function checkName(check: Check): string {
  return check.name ?? check.context ?? "check";
}

/** The overall state: failed when one failed, pending when one waits, else passed (also without checks). */
export function rollup(checks: readonly Check[]): CheckState {
  const states = checks.map(checkState);
  if (states.includes("failed")) return "failed";
  return states.includes("pending") ? "pending" : "passed";
}

export interface WatchDeps {
  run: Runner;
  config: Config;
  gitPr: typeof GitPr;
  now?: () => Date;
  log?: (text: string) => void;
}

const FIELDS = "state,mergeable,headRefOid,statusCheckRollup";
/** A tick that takes longer than this is assumed dead, and its lock is taken over. */
const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** After this many failed gh calls in a row, the watcher gives up on a PR. */
const MAX_ERRORS = 30;

class Watch {
  private readonly deps: WatchDeps;
  private readonly entry: Entry;

  constructor(deps: WatchDeps, entry: Entry) {
    this.deps = deps;
    this.entry = entry;
  }

  private get config(): Config {
    return this.deps.config;
  }

  private now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  private save(): void {
    this.entry.updated = this.now();
    saveEntry(this.config.stateDir, this.entry);
  }

  private git(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return this.deps.run("git", args, { cwd: this.entry.worktree });
  }

  private async gitText(...args: string[]): Promise<string> {
    const result = await this.git(args);
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private notesText(): string {
    return this.entry.notes.length > 0
      ? `\nThe helper:\n${this.entry.notes.map((note) => `- ${note}`).join("\n")}`
      : "";
  }

  private report(text: string): void {
    const { entry } = this;
    addSummary(this.config.stateDir, {
      entryId: entry.id,
      repo: entry.repo,
      number: entry.number,
      sessionId: entry.sessionId,
      status: entry.status,
      text,
      created: this.now(),
    });
  }

  /** Report a final state and stop watching. */
  private finish(status: FinalStatus, text: string): void {
    this.entry.status = status;
    this.report(`pi-git: PR #${this.entry.number} (${this.entry.repo}) ${text}${this.notesText()}`);
    removeEntry(this.config.stateDir, this.entry.id);
  }

  private async view(): Promise<PrView | undefined> {
    const result = await this.deps.run(
      "gh",
      ["pr", "view", String(this.entry.number), "-R", this.entry.repo, "--json", FIELDS],
      {
        cwd: this.entry.mainRoot,
      },
    );
    if (result.code !== 0) return undefined;
    try {
      return JSON.parse(result.stdout) as PrView;
    } catch {
      return undefined;
    }
  }

  async step(): Promise<void> {
    const pr = await this.view();
    if (!pr) {
      this.entry.errors++;
      if (this.entry.errors >= MAX_ERRORS)
        return this.finish("failed", `could not be read with gh ${MAX_ERRORS} times in a row; stopped watching.`);
      return this.save();
    }
    this.entry.errors = 0;
    if (pr.state === "MERGED") return this.merged();
    if (pr.state === "CLOSED")
      return this.finish("closed", "was closed without merging; the worktree and the branch are kept.");
    if (!existsSync(this.entry.worktree))
      return this.finish("failed", `has no worktree any more (${this.entry.worktree}); stopped watching.`);
    if (pr.mergeable === "CONFLICTING") return this.fix(pr, "conflict");
    const state = rollup(pr.statusCheckRollup ?? []);
    if (state === "failed") return this.fix(pr, "ci");
    if (state === "passed" && pr.mergeable === "MERGEABLE" && this.entry.greenSha !== pr.headRefOid) {
      this.entry.status = "green";
      this.entry.greenSha = pr.headRefOid;
      this.save();
      return this.report(
        `pi-git: PR #${this.entry.number} (${this.entry.repo}) is green and ready to merge: ${this.entry.url}${this.notesText()}`,
      );
    }
    return this.save();
  }

  /** After the merge: remove the worktree and the local branch, when the worktree is clean. */
  private async merged(): Promise<void> {
    const { worktree, mainRoot, branch } = this.entry;
    if (!existsSync(worktree)) return this.finish("merged", `is merged. The worktree was already gone.`);
    if ((await this.gitText("status", "--porcelain")) !== "") {
      return this.finish("merged", `is merged. The worktree ${worktree} has uncommitted changes, so it is kept.`);
    }
    const remove = await this.deps.run("git", ["worktree", "remove", worktree], { cwd: mainRoot });
    const deleted = await this.deps.run("git", ["branch", "-D", branch], { cwd: mainRoot });
    await this.deps.run("git", ["fetch", "origin", "--prune"], { cwd: mainRoot });
    if (remove.code !== 0 || deleted.code !== 0) {
      return this.finish(
        "merged",
        `is merged, but the cleanup failed:\n${clipEnd(`${outputOf(remove)}\n${outputOf(deleted)}`, 2000)}`,
      );
    }
    return this.finish("merged", `is merged; removed the worktree ${worktree} and the branch ${branch}.`);
  }

  /** Bring the worktree to the head of the PR; a string is why that is not possible. */
  private async atHead(head: string): Promise<string | undefined> {
    if ((await this.gitText("status", "--porcelain")) !== "")
      return `the worktree ${this.entry.worktree} has uncommitted changes`;
    await this.git(["fetch", "origin", this.entry.branch, this.entry.base]);
    const local = await this.gitText("rev-parse", "HEAD");
    if (local === head) return undefined;
    if ((await this.git(["merge-base", "--is-ancestor", local, head])).code !== 0) {
      return `the worktree has commits that are not on GitHub (${local.slice(0, 8)})`;
    }
    const merge = await this.git(["merge", "--ff-only", head]);
    return merge.code === 0 ? undefined : `could not update the worktree: ${outputOf(merge)}`;
  }

  /** Let the helper fix red CI or a conflict, once per head, within the attempts. */
  private async fix(pr: PrView, kind: "ci" | "conflict"): Promise<void> {
    if (this.entry.fixedSha === pr.headRefOid) return this.save();
    if (this.entry.attempts >= this.config.attempts) {
      const what = kind === "ci" ? "CI still fails" : "still conflicts with the base";
      return this.finish(
        "failed",
        `needs you: ${what} after ${this.entry.attempts} fixes by the helper. ${this.entry.url}`,
      );
    }
    const problem = await this.atHead(pr.headRefOid);
    if (problem) return this.finish("failed", `needs you: ${problem}. ${this.entry.url}`);
    this.entry.attempts++;
    this.entry.fixedSha = pr.headRefOid;
    this.entry.status = "watching";
    this.save();
    this.deps.log?.(`${this.entry.id}: fixing ${kind} (attempt ${this.entry.attempts})`);
    const failure = kind === "ci" ? await this.fixCi(pr) : await this.fixConflict(pr);
    if (failure) return this.finish("failed", `needs you: ${failure}. ${this.entry.url}`);
    this.save();
  }

  private async failedLogs(pr: PrView): Promise<string> {
    const parts: string[] = [];
    for (const check of pr.statusCheckRollup.filter((item) => checkState(item) === "failed")) {
      const url = check.detailsUrl ?? check.targetUrl ?? "";
      const run = /\/actions\/runs\/(\d+)/.exec(url)?.[1];
      let log = "";
      if (run) {
        const view = await this.deps.run("gh", ["run", "view", run, "-R", this.entry.repo, "--log-failed"], {
          cwd: this.entry.mainRoot,
        });
        log = clipEnd(view.stdout, 15_000);
      }
      parts.push(
        `### ${checkName(check)}: ${check.conclusion ?? check.state ?? "failed"}\n${url}\n${check.description ?? ""}\n${log}`.trim(),
      );
    }
    return parts.join("\n\n");
  }

  private async fixCi(pr: PrView): Promise<string | undefined> {
    const logs = await this.failedLogs(pr);
    const names = pr.statusCheckRollup.filter((check) => checkState(check) === "failed").map(checkName);
    const fix = await runHelper(this.deps.run, this.config, {
      cwd: this.entry.worktree,
      prompt: ciFixPrompt(this.entry.attempts, this.config.attempts),
      input: `What the PR is for:\n${this.entry.intent}\n\nFailing checks of PR #${this.entry.number}:\n${logs}\n`,
      fix: true,
    });
    if (!fix.ok) return fix.failure;
    this.entry.notes.push(`CI (${names.join(", ")}): ${fix.text.split("\n")[0]?.slice(0, 300)}`);
    if (/^CANNOT FIX:/m.test(fix.text)) return `the helper cannot fix CI (${names.join(", ")}): ${fix.text}`;
    if ((await this.gitText("status", "--porcelain")) === "") {
      // No change: the helper thinks the failure is not caused by the PR. Run the failed jobs once more.
      for (const url of pr.statusCheckRollup
        .filter((check) => checkState(check) === "failed")
        .map((check) => check.detailsUrl ?? "")) {
        const run = /\/actions\/runs\/(\d+)/.exec(url)?.[1];
        if (run)
          await this.deps.run("gh", ["run", "rerun", run, "-R", this.entry.repo, "--failed"], {
            cwd: this.entry.mainRoot,
          });
      }
      return undefined;
    }
    const pushed = await this.deps.gitPr(
      {
        path: this.entry.worktree,
        intent: `${this.entry.intent}\n\nThis commit fixes the failing CI checks: ${names.join(", ")}.`,
        base: this.entry.base,
        updatePr: false,
      },
      { run: this.deps.run, config: this.config, progress: () => {} },
    );
    return pushed.ok ? undefined : pushed.summary;
  }

  /** Whether one of the files still has conflict markers. */
  private hasMarkers(files: string): boolean {
    return files
      .split("\n")
      .filter((file) => file !== "")
      .some((file) => {
        try {
          return /^(<<<<<<<|>>>>>>>) /m.test(readFileSync(join(this.entry.worktree, file), "utf8"));
        } catch {
          return false;
        }
      });
  }

  private async fixConflict(pr: PrView): Promise<string | undefined> {
    const env = { GIT_EDITOR: "true" };
    const rebase = await this.deps.run("git", ["rebase", `origin/${this.entry.base}`], {
      cwd: this.entry.worktree,
      env,
    });
    let inRebase = rebase.code !== 0;
    for (let round = 0; inRebase && round < 20; round++) {
      const files = await this.gitText("diff", "--name-only", "--diff-filter=U");
      const fix = await runHelper(this.deps.run, this.config, {
        cwd: this.entry.worktree,
        prompt: conflictPrompt(this.entry.base),
        input: `What the PR is for:\n${this.entry.intent}\n\nFiles with conflicts:\n${files}\n\nThe conflicts:\n${clipEnd(await this.gitText("diff"), 30_000)}\n`,
        fix: true,
      });
      if (!fix.ok || /^CANNOT FIX:/m.test(fix.text) || this.hasMarkers(files)) {
        await this.git(["rebase", "--abort"]);
        return `the helper could not resolve the conflict with ${this.entry.base}${fix.ok ? `: ${fix.text}` : `: ${fix.failure}`}`;
      }
      this.entry.notes.push(
        `conflict with ${this.entry.base} in ${files.split("\n").join(", ")}: ${fix.text.split("\n")[0]?.slice(0, 300)}`,
      );
      await this.git(["add", "-A"]);
      const next = await this.deps.run("git", ["rebase", "--continue"], { cwd: this.entry.worktree, env });
      inRebase = next.code !== 0 && (await this.git(["rev-parse", "-q", "--verify", "REBASE_HEAD"])).code === 0;
      if (next.code !== 0 && !inRebase) return `git rebase --continue failed: ${outputOf(next)}`;
    }
    if (inRebase) {
      await this.git(["rebase", "--abort"]);
      return `the rebase on ${this.entry.base} did not finish`;
    }
    const pushed = await this.deps.gitPr(
      {
        path: this.entry.worktree,
        intent: this.entry.intent,
        base: this.entry.base,
        updatePr: false,
        forceWithLease: pr.headRefOid,
      },
      { run: this.deps.run, config: this.config, progress: () => {} },
    );
    return pushed.ok ? undefined : pushed.summary;
  }
}

/** One round of the watcher: every queued PR once. Returns how many it looked at. */
export async function tick(deps: WatchDeps): Promise<number> {
  const release = lock(deps.config.stateDir, "watcher", LOCK_MAX_AGE_MS);
  if (!release) {
    deps.log?.("another watcher is running");
    return 0;
  }
  try {
    const entries = loadEntries(deps.config.stateDir);
    for (const entry of entries) {
      try {
        await new Watch(deps, entry).step();
      } catch (error) {
        deps.log?.(`${entry.id}: ${(error as Error).message}`);
      }
    }
    return entries.length;
  } finally {
    release();
  }
}
