import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addAttention, attentionId, clearAttention, notifyTerminals } from "./attention.ts";
import type { Config } from "./config.ts";
import { clipEnd, outputOf, type Runner } from "./exec.ts";
import { runHelper } from "./helper.ts";
import {
  backToBranch,
  hasWork,
  isWorkspace,
  jjAtHead,
  jjForget,
  nextConflict,
  openConflict,
  operation,
  rebaseOnBase,
  restoreOperation,
  settleConflict,
} from "./jj.ts";
import type { gitPr as GitPr } from "./pr.ts";
import { ciFixPrompt, conflictPrompt } from "./prompts.ts";
import {
  addSummary,
  type Entry,
  type FinalStatus,
  loadEntries,
  lock,
  pruneDelivered,
  removeEntry,
  saveEntry,
} from "./state.ts";
import { effective, loadSwitch, type Step } from "./switch.ts";

/** gh's view of a PR, as far as the watcher needs it. */
export interface PrView {
  state: "OPEN" | "MERGED" | "CLOSED";
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headRefOid: string;
  statusCheckRollup: Check[];
  /** The base branch; GitHub changes it when the base of a stacked PR is merged and deleted. */
  baseRefName?: string;
  baseRefOid?: string;
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

const FIELDS = "state,mergeable,headRefOid,statusCheckRollup,baseRefName,baseRefOid";
/** A tick that takes longer than this is assumed dead, and its lock is taken over. */
const LOCK_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Delivered summaries are kept this long, for a look back, then deleted. */
const DELIVERED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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

  /** Whether one of the steps is locked in the repository of the PR (/git). */
  private locked(...steps: Step[]): boolean {
    const fallback = this.config.locked ? "locked" : "unlocked";
    const value = loadSwitch(this.config.stateDir);
    return steps.some((step) => effective(value, this.entry.repo, step, fallback, this.config.repos).lock === "locked");
  }

  private notesText(): string {
    return this.entry.notes.length > 0
      ? `\nThe helper:\n${this.entry.notes.map((note) => `- ${note}`).join("\n")}`
      : "";
  }

  private report(text: string): void {
    const { entry } = this;
    if (entry.quiet) return;
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

  /** Report a final state and stop watching. A failure needs the user; anything else answers it. */
  private async finish(status: FinalStatus, text: string): Promise<void> {
    this.entry.status = status;
    const full = `pi-git: PR #${this.entry.number} (${this.entry.repo}) ${text}${this.notesText()}`;
    this.report(full);
    removeEntry(this.config.stateDir, this.entry.id);
    if (status === "failed") await this.needYou(full);
    else this.answered();
  }

  /** Remember that the PR needs the user (the tmux sign shows it), and notify once. */
  private async needYou(text: string): Promise<void> {
    const { fresh } = addAttention(
      this.config.stateDir,
      { kind: "watcher", repo: this.entry.repo, text },
      this.entry.id,
    );
    if (fresh) await notifyTerminals(this.deps.run, "pi-git", text);
  }

  private answered(): void {
    const id = attentionId("watcher", this.entry.repo, this.entry.id);
    clearAttention(this.config.stateDir, (item) => item.id === id);
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
    await this.recover();
    const pr = await this.view();
    if (!pr) {
      this.entry.errors++;
      if (this.entry.errors >= MAX_ERRORS)
        return this.finish("failed", `could not be read with gh ${MAX_ERRORS} times in a row; stopped watching.`);
      return this.save();
    }
    this.entry.errors = 0;
    if (pr.state === "MERGED") return this.merged(pr.headRefOid);
    if (pr.state === "CLOSED")
      return this.finish("closed", "was closed without merging; the worktree and the branch are kept.");
    if (!existsSync(this.entry.worktree))
      return this.finish("failed", `has no worktree any more (${this.entry.worktree}); stopped watching.`);
    return this.open(pr);
  }

  /** An open PR with its worktree: follow a moved base, fix conflicts and red CI, report green once. */
  private async open(pr: PrView): Promise<void> {
    if (pr.baseRefName && pr.baseRefName !== this.entry.base) return this.restack(pr, pr.baseRefName);
    if (pr.baseRefOid) this.entry.baseSha = pr.baseRefOid;
    if (pr.mergeable === "CONFLICTING") return this.fix(pr, "conflict");
    const state = rollup(pr.statusCheckRollup ?? []);
    if (state === "failed") return this.fix(pr, "ci");
    if (state === "passed" && pr.mergeable === "MERGEABLE" && this.entry.greenSha !== pr.headRefOid) {
      this.entry.status = "green";
      this.entry.greenSha = pr.headRefOid;
      this.save();
      this.answered();
      return this.report(
        `pi-git: PR #${this.entry.number} (${this.entry.repo}) is green and ready to merge: ${this.entry.url}${this.notesText()}`,
      );
    }
    return this.save();
  }

  /** A jj workspace: jj keeps its history, so some steps go through jj. */
  private get jj(): boolean {
    return isWorkspace(this.entry.worktree);
  }

  /** Uncommitted changes, or work in progress of a jj workspace. */
  private async dirty(): Promise<boolean> {
    if (this.jj) return hasWork(this.deps.run, this.entry.worktree);
    return (await this.gitText("status", "--porcelain")) !== "";
  }

  /** Remove the worktree and its branch: with git, or for a jj workspace also with jj. */
  private async removeWorktree(): Promise<string | undefined> {
    const { worktree, mainRoot, branch } = this.entry;
    const jj = this.jj;
    const remove = await this.deps.run("git", ["worktree", "remove", ...(jj ? ["--force"] : []), worktree], {
      cwd: mainRoot,
    });
    if (jj) {
      if (remove.code === 0) await jjForget(this.deps.run, mainRoot, worktree, branch);
      return remove.code === 0 ? undefined : outputOf(remove);
    }
    const deleted = await this.deps.run("git", ["branch", "-D", branch], { cwd: mainRoot });
    if (remove.code === 0 && deleted.code === 0) return undefined;
    return `${outputOf(remove)}\n${outputOf(deleted)}`;
  }

  /** After the merge: remove the worktree and the local branch, when the worktree is clean. */
  /**
   * Commits of the branch that the merged PR does not have: on the worktree's branch (pushed after
   * the merge, or never pushed) or on GitHub. The text says where; undefined when there are none.
   */
  private async unmerged(head: string): Promise<string | undefined> {
    const { branch, number } = this.entry;
    const known = async () => (await this.git(["cat-file", "-e", `${head}^{commit}`])).code === 0;
    if (!(await known())) await this.git(["fetch", "origin", `pull/${number}/head`]);
    if (!(await known())) return `the PR's head ${head.slice(0, 8)} could not be fetched to compare`;
    await this.git(["fetch", "origin", branch]);
    const tips: Array<[string, string]> = [
      [this.jj ? `refs/heads/${branch}` : "HEAD", "the worktree"],
      [`refs/remotes/origin/${branch}`, "GitHub"],
    ];
    const found: string[] = [];
    for (const [ref, where] of tips) {
      const tip = await this.gitText("rev-parse", "--verify", "-q", ref);
      if (tip === "" || (await this.git(["merge-base", "--is-ancestor", tip, head])).code === 0) continue;
      const count = await this.gitText("rev-list", "--count", `${head}..${tip}`);
      found.push(`${count} on ${where} (${tip.slice(0, 8)})`);
    }
    return found.length > 0 ? `commits that are not in the PR: ${found.join(", ")}` : undefined;
  }

  private async merged(head: string): Promise<void> {
    const { worktree, mainRoot, branch } = this.entry;
    if (!existsSync(worktree)) return this.finish("merged", `is merged. The worktree was already gone.`);
    if (this.locked("worktree")) {
      return this.finish(
        "merged",
        `is merged. The worktree ${worktree} and the branch are kept: worktree is locked in ${this.entry.repo}.`,
      );
    }
    if (await this.dirty()) {
      return this.finish("merged", `is merged. The worktree ${worktree} has uncommitted changes, so it is kept.`);
    }
    const extra = await this.unmerged(head);
    if (extra) {
      const text = `is merged, but the branch ${branch} has ${extra}. The worktree ${worktree} and the branch are kept: open a new PR for them.`;
      // Work would be lost: this needs the user, like a failure.
      return this.finish("failed", text);
    }
    const failure = await this.removeWorktree();
    const remote = await this.deleteRemoteBranch();
    await this.deps.run("git", ["fetch", "origin", "--prune"], { cwd: mainRoot });
    if (failure !== undefined)
      return this.finish("merged", `is merged, but the cleanup failed:\n${clipEnd(failure, 2000)}`);
    return this.finish("merged", `is merged; removed the worktree ${worktree} and the branch ${branch}${remote}.`);
  }

  /** Delete the branch on GitHub when GitHub did not (no "delete branch on merge"); the text for the report. */
  private async deleteRemoteBranch(): Promise<string> {
    const { mainRoot, branch, repo } = this.entry;
    const exists = await this.deps.run("git", ["ls-remote", "--exit-code", "--heads", "origin", branch], {
      cwd: mainRoot,
    });
    if (exists.code !== 0) return "";
    const deleted = await this.deps.run("gh", ["api", "-X", "DELETE", `repos/${repo}/git/refs/heads/${branch}`], {
      cwd: mainRoot,
    });
    return deleted.code === 0
      ? ", also on GitHub"
      : `; the branch on GitHub could not be deleted (${outputOf(deleted).split("\n")[0]})`;
  }

  /** Bring the worktree to the head of the PR; a string is why that is not possible. */
  private async atHead(head: string): Promise<string | undefined> {
    if (this.jj) return jjAtHead(this.deps.run, this.entry.worktree, this.entry.branch, head);
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

  /**
   * The base of a stacked PR was merged, and GitHub moved the PR to the next base. With squash
   * merges, the branch still has the old base's commits: rebase only the PR's own commits (those
   * after the last seen tip of the old base) onto the new base, and force-push with a lease.
   */
  private async restack(pr: PrView, to: string): Promise<void> {
    if (this.locked("commit", "push")) return this.waitForUnlock(pr, "conflict");
    const from = this.entry.base;
    const upstream = this.entry.baseSha;
    this.entry.base = to;
    delete this.entry.baseSha;
    const problem = await this.atHead(pr.headRefOid);
    if (problem) return this.finish("failed", `needs you: ${problem}. ${this.entry.url}`);
    this.entry.working = "conflict";
    this.save();
    this.deps.log?.(`${this.entry.id}: ${from} was merged; rebasing on ${to}`);
    const failure = await this.fixConflict(pr, upstream);
    delete this.entry.working;
    if (failure) return this.finish("failed", `needs you: ${failure}. ${this.entry.url}`);
    this.entry.notes.push(`the base ${from} was merged; rebased the PR's own commits on ${to}`);
    this.save();
  }

  /** Let the helper fix red CI or a conflict, once per head, within the attempts. */
  private async fix(pr: PrView, kind: "ci" | "conflict"): Promise<void> {
    if (this.entry.fixedSha === pr.headRefOid) return this.save();
    if (this.locked("commit", "push")) return this.waitForUnlock(pr, kind);
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
    this.entry.working = kind;
    this.entry.status = "watching";
    this.save();
    this.deps.log?.(`${this.entry.id}: fixing ${kind} (attempt ${this.entry.attempts})`);
    const failure = kind === "ci" ? await this.fixCi(pr) : await this.fixConflict(pr);
    // Only a finished fix counts for this head; an interrupted one is cleaned up and tried again.
    this.entry.fixedSha = pr.headRefOid;
    delete this.entry.working;
    if (failure) return this.finish("failed", `needs you: ${failure}. ${this.entry.url}`);
    this.save();
  }

  /**
   * After an interruption (a reboot during a fix): abort the watcher's own rebase, and stash the
   * changes of its fix, so the worktree is clean again. Nothing is thrown away.
   */
  private async recover(): Promise<void> {
    const { working } = this.entry;
    if (working === undefined) return;
    delete this.entry.working;
    const done: string[] = [];
    if (this.jj) {
      // jj keeps the changes of the fix in the working-copy commit; the next fix sees them and stops.
      done.push("left the changes of its fix in the working-copy commit of the jj workspace");
    } else if (existsSync(this.entry.worktree)) {
      const rebaseDirs = await Promise.all(
        ["rebase-merge", "rebase-apply"].map((name) =>
          this.gitText("rev-parse", "--path-format=absolute", "--git-path", name),
        ),
      );
      if (rebaseDirs.some((dir) => dir !== "" && existsSync(dir))) {
        await this.git(["rebase", "--abort"]);
        done.push("aborted its rebase");
      }
      if ((await this.gitText("status", "--porcelain")) !== "") {
        await this.git([
          "stash",
          "push",
          "--include-untracked",
          "-m",
          `pi-git: interrupted ${working} fix of PR #${this.entry.number}`,
        ]);
        done.push("stashed the changes of its fix (git stash list)");
      }
    }
    this.entry.notes.push(`after an interruption: ${done.length > 0 ? done.join(", ") : "nothing to clean up"}`);
    this.save();
  }

  /** Report once per head that a fix waits for /git unlock. */
  private async waitForUnlock(pr: PrView, kind: "ci" | "conflict"): Promise<void> {
    const reported = this.entry.lockedSha === pr.headRefOid;
    this.entry.lockedSha = pr.headRefOid;
    this.save();
    if (reported) return;
    const what = kind === "ci" ? "CI fails" : "it conflicts with the base";
    const text = `pi-git: PR #${this.entry.number} (${this.entry.repo}): ${what}, but git changes are locked in ${this.entry.repo}. Unlock commit and push (/git unlock commit push) to let the helper fix it. ${this.entry.url}`;
    this.report(text);
    await this.needYou(text);
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

  /** Rebase on the base and let the helper resolve conflicts; `upstream` limits it to commits after that one. */
  private async fixConflict(pr: PrView, upstream?: string): Promise<string | undefined> {
    if (this.jj) return this.fixJjConflict(pr, upstream);
    const env = { GIT_EDITOR: "true" };
    const target = `origin/${this.entry.base}`;
    const args = upstream ? ["rebase", "--onto", target, upstream] : ["rebase", target];
    const rebase = await this.deps.run("git", args, {
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
    return this.pushRebased(pr);
  }

  /**
   * The jj route: rebase with jj, which records conflicts in the commits; open them one by one, oldest
   * first, let the helper resolve each, and move the resolution into its commit. On a failure
   * everything is put back (`jj op restore`).
   */
  private async fixJjConflict(pr: PrView, upstream?: string): Promise<string | undefined> {
    const { run } = this.deps;
    const { worktree: root, base, branch } = this.entry;
    const before = await operation(run, root);
    const fail = async (why: string): Promise<string> => {
      if (before) await restoreOperation(run, root, before);
      return why;
    };
    const rebased = await rebaseOnBase(run, root, base, upstream);
    if (rebased) return fail(rebased);
    for (let round = 0; round < 20; round++) {
      const commit = await nextConflict(run, root, base);
      if (commit === undefined) {
        const back = await backToBranch(run, root, branch);
        return back ? fail(back) : this.pushRebased(pr);
      }
      const failure = await this.resolveJjConflict(commit);
      if (failure) return fail(failure);
    }
    return fail(`the rebase on ${base} did not finish`);
  }

  /** One conflicted commit of a jj rebase: the helper resolves it, then it goes into the commit. */
  private async resolveJjConflict(commit: string): Promise<string | undefined> {
    const { run } = this.deps;
    const { worktree: root, base } = this.entry;
    const files = await openConflict(run, root, commit);
    if (typeof files === "string") return files;
    const contents = files
      .map((file) => {
        try {
          return `### ${file}\n${readFileSync(join(root, file), "utf8")}`;
        } catch {
          return `### ${file}\n(deleted on one side)`;
        }
      })
      .join("\n\n");
    const fix = await runHelper(run, this.config, {
      cwd: root,
      prompt: conflictPrompt(base),
      input: `What the PR is for:\n${this.entry.intent}\n\nFiles with conflicts:\n${files.join("\n")}\n\nThe conflicts:\n${clipEnd(contents, 30_000)}\n`,
      fix: true,
    });
    if (!fix.ok || /^CANNOT FIX:/m.test(fix.text) || this.hasMarkers(files.join("\n"))) {
      return `the helper could not resolve the conflict with ${base}${fix.ok ? `: ${fix.text}` : `: ${fix.failure}`}`;
    }
    this.entry.notes.push(`conflict with ${base} in ${files.join(", ")}: ${fix.text.split("\n")[0]?.slice(0, 300)}`);
    return settleConflict(run, root);
  }

  /** Push a rebased branch with a lease on the head the watcher saw; nothing when the rebase changed nothing. */
  private async pushRebased(pr: PrView): Promise<string | undefined> {
    if ((await this.gitText("rev-parse", "HEAD")) === pr.headRefOid) return undefined;
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
  const release = lock(deps.config.runtimeDir, "watcher", LOCK_MAX_AGE_MS);
  if (!release) {
    deps.log?.("another watcher is running");
    return 0;
  }
  try {
    pruneDelivered(deps.config.stateDir, DELIVERED_MAX_AGE_MS, (deps.now?.() ?? new Date()).getTime());
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
