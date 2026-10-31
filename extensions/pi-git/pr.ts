import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clipEnd, clipStart, outputOf, type Runner, type RunResult } from "./exec.ts";
import { commitStyle, findPullRequest, inspectWorktree, type PullRequest, prNumber, type Worktree } from "./git.ts";
import { askJson, runHelper } from "./helper.ts";
import {
  applyPlan,
  changedFiles,
  countWork,
  gatherWork,
  hasWork,
  onRemote,
  type PlannedCommit,
  parsePlan,
  pushTarget,
  rebaseOnRemote,
  setBookmark,
  track,
} from "./jj.ts";
import { stringField } from "./json.ts";
import { fixPrompt, messagePrompt, messageRetryPrompt, pullRequestPrompt, type Stage, splitPrompt } from "./prompts.ts";
import type { Step } from "./switch.ts";

export interface PrInput {
  /** A directory in the worktree. */
  path: string;
  /** What the change is for, in the main agent's words. */
  intent: string;
  /**
   * The commit subject and PR title, in the repository's style. With it, pi-git commits and opens the
   * PR itself (the intent is the body); the helper only writes them when it is missing or rejected.
   */
  title?: string;
  /** The base branch; default: the base of the open PR, else the default branch. */
  base?: string;
  draft?: boolean;
  /** Open or update the PR; the watcher only pushes its fixes. Default: true. */
  updatePr?: boolean;
  /** After a rebase: force-push, only when GitHub still has this sha. */
  forceWithLease?: string;
}

export interface PrResult {
  ok: boolean;
  /** The text for the main agent. */
  summary: string;
  worktree?: Worktree;
  base?: string;
  commit?: { sha: string; subject: string };
  pr?: { number: number; url: string; created: boolean };
  /** What the helper did, per step. */
  notes: string[];
  /** The locked step the run stopped before. */
  stopped?: Step;
}

export interface Deps {
  run: Runner;
  config: Config;
  progress: (text: string) => void;
  signal?: AbortSignal | undefined;
  /** Whether a step may run; a run stops before the first locked step. Default: every step. */
  allowed?: (step: Step) => boolean;
}

/** Why a run stopped before a step. */
function stoppedAt(step: Step, done: string): string {
  return `${done}Stopped before ${step}: ${step} is locked here. Ask the user to run /git unlock ${step}, or /git ${step} for one time.`;
}

/** Diff and log text in a helper's input is cut to this many characters. */
const MAX_DIFF = 40_000;
const MAX_OUTPUT = 20_000;

interface Message {
  subject: string;
  body: string;
}

function parseMessage(value: unknown): Message | Error {
  const subject = stringField(value, "subject");
  if (subject instanceof Error) return subject;
  const body = stringField(value, "body", true);
  if (body instanceof Error) return body;
  return { subject, body };
}

function parseTitle(value: unknown): { title: string; body: string } | Error {
  const title = stringField(value, "title");
  if (title instanceof Error) return title;
  const body = stringField(value, "body");
  if (body instanceof Error) return body;
  return { title, body };
}

function messageText(message: Message): string {
  return message.body === "" ? `${message.subject}\n` : `${message.subject}\n\n${message.body}\n`;
}

function firstLines(text: string, lines = 3): string {
  return text.trim().split("\n").slice(0, lines).join(" ").slice(0, 400);
}

/** One git_pr run in one worktree. */
class Flow {
  readonly notes: string[] = [];
  private readonly scratch = mkdtempSync(join(tmpdir(), "pi-git-"));
  private conventional = false;
  private recent: string[] = [];

  private readonly deps: Deps;
  private readonly wt: Worktree;
  private readonly input: PrInput;
  readonly base: string;

  constructor(deps: Deps, wt: Worktree, input: PrInput, base: string) {
    this.deps = deps;
    this.wt = wt;
    this.input = input;
    this.base = base;
  }

  dispose(): void {
    rmSync(this.scratch, { recursive: true, force: true });
  }

  git(args: string[], timeoutMs?: number): Promise<RunResult> {
    return this.deps.run("git", args, {
      cwd: this.wt.root,
      // pi-git checked the lock itself; the hard stop in the git hooks is for the agents' own commands.
      env: { PI_GIT_SWITCH: "" },
      signal: this.deps.signal,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
  }

  async gitText(...args: string[]): Promise<string> {
    const result = await this.git(args);
    return result.code === 0 ? result.stdout.trim() : "";
  }

  private file(name: string, text: string): string {
    const path = join(this.scratch, name);
    writeFileSync(path, text);
    return path;
  }

  private get checkTimeout(): number {
    return this.deps.config.checkTimeout * 1000;
  }

  async loadStyle(): Promise<void> {
    const style = await commitStyle(this.deps.run, this.wt.root, this.base);
    this.conventional = style.conventional;
    this.recent = style.recent;
  }

  /**
   * Run a check; while it fails, the helper fixes the files and the check runs again. Returns
   * undefined when the check passes, else the last output.
   */
  async untilGreen(
    stage: Stage,
    check: () => Promise<RunResult>,
    afterFix: () => Promise<void>,
  ): Promise<string | undefined> {
    const { attempts } = this.deps.config;
    for (let attempt = 1; ; attempt++) {
      const result = await check();
      if (result.code === 0) return undefined;
      const output = clipEnd(outputOf(result), MAX_OUTPUT);
      if (result.failure === "aborted" || attempt > attempts) return output;
      this.deps.progress(`${stage}: checks fail; the helper fixes them (attempt ${attempt}/${attempts})`);
      const fix = await runHelper(this.deps.run, this.deps.config, {
        cwd: this.wt.root,
        prompt: fixPrompt(stage, attempt, attempts),
        input: `What the change is for:\n${this.input.intent}\n\nOutput of the ${stage} checks:\n${output}\n`,
        fix: true,
        signal: this.deps.signal,
      });
      if (!fix.ok) return `${output}\n\n${fix.failure}`;
      this.notes.push(`${stage}: ${firstLines(fix.text)}`);
      if (/^CANNOT FIX:/m.test(fix.text)) return `${output}\n\nThe helper: ${fix.text}`;
      await afterFix();
    }
  }

  /** The main agent's title did not pass the commit-msg hook: the helper writes the PR text too. */
  private titleRejected = false;
  /**
   * The work of a jj workspace spans several turns: the main agent's title covers only its last
   * one, so the helper splits the work and writes the PR text, with the title as a hint.
   */
  private severalTurns = false;

  stageAll = async (): Promise<void> => {
    await this.git(["add", "-A"]);
  };

  /** The base, when the change is stacked on another branch (jj keeps that branch's commits out of the work). */
  private get stackBase(): string | undefined {
    return this.base === this.wt.defaultBranch ? undefined : this.base;
  }

  /** What is pushed and goes in the PR: HEAD, or in a jj workspace the branch (HEAD is the work in progress there). */
  get tip(): string {
    return this.wt.jj ? `refs/heads/${this.wt.branch}` : "HEAD";
  }

  /** Whether the worktree has changes to commit: uncommitted files, or work in progress in a jj workspace. */
  async hasChanges(): Promise<boolean> {
    if (this.wt.jj) return hasWork(this.deps.run, this.wt.root, this.stackBase);
    return (await this.gitText("status", "--porcelain")) !== "";
  }

  /** Commits ahead of the base; in a jj workspace, the branch first moves to the newest logical commit. */
  async ahead(): Promise<number | string> {
    if (this.wt.jj) {
      const target = await pushTarget(this.deps.run, this.wt.root, this.stackBase);
      if (target instanceof Error) return target.message;
      if (target) await setBookmark(this.deps.run, this.wt.root, this.wt.branch, target);
    }
    return Number((await this.gitText("rev-list", "--count", `origin/${this.base}..${this.tip}`)) || 0);
  }

  /** Ask the helper for a commit message that the commit-msg hook accepts. */
  async writeMessage(): Promise<Message | Error> {
    const stat = await this.gitText("diff", "--cached", "--stat");
    const diff = await this.gitText("diff", "--cached");
    const input = [
      `What the change is for:\n${this.input.intent}`,
      `Branch: ${this.wt.branch}`,
      `Recent subjects on ${this.base}:\n${this.recent.join("\n")}`,
      `Staged changes:\n${stat}`,
      `Staged diff:\n${clipStart(diff, MAX_DIFF)}`,
    ].join("\n\n");
    let prompt = messagePrompt(this.conventional);
    if (this.input.title && !this.severalTurns) {
      const own = { subject: this.input.title.trim(), body: this.input.intent.trim() };
      const file = this.file("COMMIT_MSG", messageText(own));
      const hook = await this.git(["hook", "run", "--ignore-missing", "commit-msg", "--", file]);
      if (hook.code === 0) return own;
      this.titleRejected = true;
      // The title does not pass the repository's commit-msg hook: the helper writes one that does.
      prompt = messageRetryPrompt(this.conventional, clipEnd(outputOf(hook), 4000));
    }
    for (let attempt = 0; attempt <= this.deps.config.attempts; attempt++) {
      this.deps.progress("the helper writes the commit message");
      const message = await askJson(
        this.deps.run,
        this.deps.config,
        { cwd: this.wt.root, prompt, input, signal: this.deps.signal },
        parseMessage,
      );
      if (message instanceof Error) return message;
      const file = this.file("COMMIT_MSG", messageText(message));
      const hook = await this.git(["hook", "run", "--ignore-missing", "commit-msg", "--", file]);
      if (hook.code === 0) return message;
      prompt = messageRetryPrompt(this.conventional, clipEnd(outputOf(hook), 4000));
    }
    return new Error("the commit-msg hook rejected every message the helper wrote");
  }

  /** Stage, run the pre-commit checks until green, write the message, commit. */
  async commit(): Promise<{ sha: string; subject: string } | string> {
    if (this.wt.jj) return this.jjCommit();
    await this.stageAll();
    this.deps.progress("pre-commit: running the checks");
    const precommit = await this.untilGreen(
      "pre-commit",
      () => this.git(["hook", "run", "--ignore-missing", "pre-commit"], this.checkTimeout),
      this.stageAll,
    );
    if (precommit !== undefined) return `The pre-commit checks still fail:\n${precommit}`;
    await this.stageAll();
    const message = await this.writeMessage();
    if (message instanceof Error) return `No commit message: ${message.message}`;
    const file = this.file("COMMIT_MSG", messageText(message));
    this.deps.progress("committing");
    const commit = await this.untilGreen(
      "commit",
      () => this.git(["commit", "-F", file], this.checkTimeout),
      this.stageAll,
    );
    if (commit !== undefined) return `The commit was refused:\n${commit}`;
    return { sha: await this.gitText("rev-parse", "--short", "HEAD"), subject: message.subject };
  }

  /** Whether HEAD is already on origin. */
  async headPushed(): Promise<boolean> {
    return (await this.gitText("branch", "-r", "--contains", this.tip)) !== "";
  }

  /** The pre-commit checks on all changes until green; undefined when they pass. */
  private preCommit(): Promise<string | undefined> {
    this.deps.progress("pre-commit: running the checks");
    return this.untilGreen(
      "pre-commit",
      () => this.git(["hook", "run", "--ignore-missing", "pre-commit"], this.checkTimeout),
      this.stageAll,
    );
  }

  /**
   * The jj route: collect the work in progress of all turns in the working-copy commit, run the
   * pre-commit checks on it, and make logical commits that the commit-msg hook accepts.
   */
  private async jjCommit(): Promise<{ sha: string; subject: string } | string> {
    this.severalTurns = (await countWork(this.deps.run, this.wt.root, this.stackBase)) > 1;
    const gathered = await gatherWork(this.deps.run, this.wt.root, this.stackBase);
    if (gathered) return gathered;
    await this.stageAll();
    const precommit = await this.preCommit();
    if (precommit !== undefined) return `The pre-commit checks still fail:\n${precommit}`;
    await this.stageAll();
    const plan = await this.planCommits();
    if (plan instanceof Error) return `No commit message: ${plan.message}`;
    this.deps.progress(plan.length > 1 ? `committing as ${plan.length} commits` : "committing");
    const failure = await applyPlan(this.deps.run, this.wt.root, plan);
    if (failure) return failure;
    await setBookmark(this.deps.run, this.wt.root, this.wt.branch, "@-");
    const subjects = plan.map((commit) => commit.message.split("\n")[0] ?? "");
    return {
      sha: await this.gitText("rev-parse", "--short", this.tip),
      subject: subjects.length > 1 ? `${subjects.length} commits: ${subjects.join("; ")}` : (subjects[0] ?? ""),
    };
  }

  /** How the changes become commits: the helper's split, or one commit with the agent's title or one file. */
  private async planCommits(): Promise<PlannedCommit[] | Error> {
    const files = await changedFiles(this.deps.run, this.wt.root);
    if (files.length === 0) return new Error("no changes left after the checks");
    const single = async (): Promise<PlannedCommit[] | Error> => {
      const message = await this.writeMessage();
      return message instanceof Error ? message : [{ files, message: messageText(message) }];
    };
    if ((this.input.title && !this.severalTurns) || files.length === 1) return single();
    const input = [
      `What the change is for:\n${this.input.intent}`,
      this.input.title ? `The agent's title, for its last turn only: ${this.input.title}` : "",
      `Branch: ${this.wt.branch}`,
      `Recent subjects on ${this.base}:\n${this.recent.join("\n")}`,
      `Changed files:\n${files.join("\n")}`,
      `Diff:\n${clipStart(await this.gitText("diff", "--cached"), MAX_DIFF)}`,
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    let problem: string | undefined;
    for (let attempt = 0; attempt <= this.deps.config.attempts; attempt++) {
      this.deps.progress("the helper splits the changes into commits");
      const plan = await askJson(
        this.deps.run,
        this.deps.config,
        { cwd: this.wt.root, prompt: splitPrompt(this.conventional, problem), input, signal: this.deps.signal },
        (value) => parsePlan(value, files),
      );
      // A split the helper cannot get right becomes one commit.
      if (plan instanceof Error) return single();
      problem = await this.rejected(plan);
      if (problem === undefined) return plan;
    }
    return single();
  }

  /** The output of the commit-msg hook for the first message it rejects. */
  private async rejected(plan: readonly PlannedCommit[]): Promise<string | undefined> {
    for (const commit of plan) {
      const hook = await this.git([
        "hook",
        "run",
        "--ignore-missing",
        "commit-msg",
        "--",
        this.file("COMMIT_MSG", commit.message),
      ]);
      if (hook.code !== 0) return clipEnd(outputOf(hook), 4000);
    }
    return undefined;
  }

  /** The jj route of commitFix: fold the fix into an unpushed commit, else make it a commit of its own. */
  private jjCommitFix = async (): Promise<void> => {
    const { run } = this.deps;
    const { root, branch } = this.wt;
    if (!(await hasWork(run, root, this.stackBase))) return;
    const tip = `bookmarks(exact:${JSON.stringify(branch)})`;
    if (!(await onRemote(run, root, tip))) {
      await this.jj(["squash", "--into", tip, "--use-destination-message"]);
      return;
    }
    await this.stageAll();
    const message = await this.writeMessage();
    const text = message instanceof Error ? "fix: make the checks pass\n" : messageText(message);
    await this.jj(["describe", "-m", text]);
    await this.jj(["new"]);
    await setBookmark(run, root, branch, "@-");
  };

  private jj(args: string[]) {
    return this.deps.run("jj", ["--no-pager", "--color=never", ...args], {
      cwd: this.wt.root,
      env: { PI_GIT_SWITCH: "" },
      signal: this.deps.signal,
    });
  }

  /** After the helper fixed a pre-push failure: amend an unpushed commit, else add a commit. */
  commitFix = async (): Promise<void> => {
    if (this.wt.jj) return this.jjCommitFix();
    await this.stageAll();
    if ((await this.git(["diff", "--cached", "--quiet"])).code === 0) return;
    if (!(await this.headPushed())) {
      await this.git(["commit", "--amend", "--no-edit"], this.checkTimeout);
      return;
    }
    const message = await this.writeMessage();
    const subject = message instanceof Error ? "fix: make the checks pass" : messageText(message);
    await this.git(["commit", "-F", this.file("COMMIT_MSG", subject)], this.checkTimeout);
  };

  /** Push; when GitHub has commits the worktree lacks (the watcher pushed), rebase on them first. */
  push = async (): Promise<RunResult> => {
    if (this.wt.jj) return this.jjPush();
    const lease = this.input.forceWithLease;
    if (lease !== undefined) {
      return this.git(
        ["push", `--force-with-lease=${this.wt.branch}:${lease}`, "-u", "origin", `HEAD:${this.wt.branch}`],
        this.checkTimeout,
      );
    }
    const push = await this.git(["push", "-u", "origin", "HEAD"], this.checkTimeout);
    if (push.code === 0 || !/\[rejected\]|non-fast-forward|fetch first/.test(push.stderr)) return push;
    this.deps.progress("the branch on GitHub moved; rebasing on it");
    await this.git(["fetch", "origin", this.wt.branch]);
    const rebase = await this.git(["rebase", `origin/${this.wt.branch}`]);
    if (rebase.code !== 0) {
      await this.git(["rebase", "--abort"]);
      return {
        ...rebase,
        stderr: `The branch on GitHub has commits that conflict with this worktree.\n${rebase.stderr}`,
      };
    }
    return this.git(["push", "-u", "origin", "HEAD"], this.checkTimeout);
  };

  /**
   * The jj route of push: `git push` of the branch (so the pre-push hook runs), then jj follows the
   * branch on GitHub. When GitHub has commits the workspace lacks, jj rebases on them first.
   */
  private jjPush = async (): Promise<RunResult> => {
    const { run } = this.deps;
    const { root, branch } = this.wt;
    const ref = `refs/heads/${branch}:refs/heads/${branch}`;
    const lease = this.input.forceWithLease;
    const args =
      lease === undefined ? ["push", "origin", ref] : ["push", `--force-with-lease=${branch}:${lease}`, "origin", ref];
    let push = await this.git(args, this.checkTimeout);
    if (push.code !== 0 && lease === undefined && /\[rejected\]|non-fast-forward|fetch first/.test(push.stderr)) {
      this.deps.progress("the branch on GitHub moved; rebasing on it with jj");
      const failure = await rebaseOnRemote(run, root, branch);
      if (failure)
        return { ...push, stderr: `The branch on GitHub has commits that conflict with this workspace.\n${failure}` };
      const ahead = await this.ahead();
      if (typeof ahead === "string") return { ...push, stderr: ahead };
      push = await this.git(args, this.checkTimeout);
    }
    if (push.code === 0) await track(run, root, branch);
    return push;
  };

  private template(): string {
    for (const name of [
      ".github/pull_request_template.md",
      ".github/PULL_REQUEST_TEMPLATE.md",
      "pull_request_template.md",
    ]) {
      const path = join(this.wt.root, name);
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    return "";
  }

  /** Open the PR, or update the open one. */
  async pullRequest(
    existing: PullRequest | undefined,
  ): Promise<{ number: number; url: string; created: boolean } | string> {
    const range = `origin/${this.base}...${this.tip}`;
    const stacked =
      this.base === this.wt.defaultBranch ? undefined : await findPullRequest(this.deps.run, this.wt.root, this.base);
    const input = [
      stacked
        ? `This PR is stacked on PR #${stacked.number} (${this.base}). Start the body with: "Stacked on #${stacked.number}; merge that first."`
        : "",
      `What the change is for:\n${this.input.intent}`,
      this.input.title && this.severalTurns
        ? `The agent's title, for its last turn only (the change has several turns): ${this.input.title}`
        : "",
      `Branch: ${this.wt.branch} into ${this.base}`,
      `Recent subjects on ${this.base}:\n${this.recent.join("\n")}`,
      `Commits:\n${clipStart(await this.gitText("log", "--format=- %s%n%n%b", `origin/${this.base}..${this.tip}`), 8000)}`,
      `Changed files:\n${await this.gitText("diff", "--stat", range)}`,
      `Diff:\n${clipStart(await this.gitText("diff", range), MAX_DIFF)}`,
      "Testing: the pre-commit and pre-push hooks of the repository passed locally.",
      this.notes.length > 0 ? `Fixed by the helper on the way:\n${this.notes.join("\n")}` : "",
      this.template() ? `Template:\n${this.template()}` : "",
      existing ? `Current title: ${existing.title}\nCurrent body:\n${existing.body}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    const own = this.input.title && !this.titleRejected && !this.severalTurns;
    const text = own ? this.ownText() : await this.helperText(existing, input);
    if (text instanceof Error) return `No PR text: ${text.message}`;
    return this.publish(existing, text);
  }

  /** The PR text from the main agent's title and intent: no helper. */
  private ownText(): { title: string; body: string } {
    const notes =
      this.notes.length > 0 ? `\n\nFixed by the helper on the way:\n${this.notes.map((n) => `- ${n}`).join("\n")}` : "";
    return {
      title: (this.input.title ?? "").trim(),
      body: `${this.input.intent.trim()}\n\n## Testing\nThe pre-commit and pre-push hooks of the repository passed locally.${notes}\n`,
    };
  }

  private async helperText(existing: PullRequest | undefined, input: string) {
    this.deps.progress(existing ? `the helper updates PR #${existing.number}` : "the helper writes the PR");
    return askJson(
      this.deps.run,
      this.deps.config,
      {
        cwd: this.wt.root,
        prompt: pullRequestPrompt(this.conventional, existing !== undefined),
        input,
        signal: this.deps.signal,
      },
      parseTitle,
    );
  }

  private async publish(existing: PullRequest | undefined, text: { title: string; body: string }) {
    const bodyFile = this.file("PR_BODY.md", text.body);
    if (existing) {
      const edit = await this.deps.run(
        "gh",
        ["pr", "edit", String(existing.number), "--title", text.title, "--body-file", bodyFile],
        { cwd: this.wt.root },
      );
      if (edit.code !== 0) return `gh pr edit failed:\n${outputOf(edit)}`;
      return { number: existing.number, url: existing.url, created: false };
    }
    const args = [
      "pr",
      "create",
      "--base",
      this.base,
      "--head",
      this.wt.branch,
      "--title",
      text.title,
      "--body-file",
      bodyFile,
    ];
    const create = await this.deps.run("gh", this.input.draft ? [...args, "--draft"] : args, { cwd: this.wt.root });
    const url = create.stdout.trim().split("\n").pop() ?? "";
    const number = prNumber(url);
    if (create.code !== 0 || number === undefined) return `gh pr create failed:\n${outputOf(create)}`;
    return { number, url, created: true };
  }
}

function failed(reason: string, flow?: Flow, extra: Partial<PrResult> = {}): PrResult {
  const notes = flow?.notes ?? [];
  const helper = notes.length > 0 ? `\n\nThe helper tried:\n${notes.map((note) => `- ${note}`).join("\n")}` : "";
  return { ok: false, summary: `git_pr stopped: ${clipEnd(reason, 6000)}${helper}`, notes, ...extra };
}

function success(
  flow: Flow,
  wt: Worktree,
  commit: PrResult["commit"],
  pr: NonNullable<PrResult["pr"]>,
  draft: boolean,
): PrResult {
  const lines = [
    `${pr.created ? "Opened" : "Updated"} PR #${pr.number}${draft && pr.created ? " (draft)" : ""}: ${pr.url}`,
    commit
      ? `Commit ${commit.sha} "${commit.subject}" on ${wt.branch}, pushed; the local checks passed.`
      : `Pushed ${wt.branch}; the local checks passed.`,
  ];
  if (flow.notes.length > 0) lines.push("The helper fixed on the way:", ...flow.notes.map((note) => `- ${note}`));
  return {
    ok: true,
    summary: lines.join("\n"),
    worktree: wt,
    base: flow.base,
    ...(commit ? { commit } : {}),
    pr,
    notes: flow.notes,
  };
}

/** The worktree, the base, and a flow that fetched the base and knows the commit style; a string is why not. */
async function start(
  input: PrInput,
  deps: Deps,
): Promise<{ wt: Worktree; flow: Flow; existing: PullRequest | undefined } | PrResult> {
  const wt = await inspectWorktree(deps.run, input.path);
  if (typeof wt === "string") return failed(wt);
  const existing = await findPullRequest(deps.run, wt.root, wt.branch);
  const base = input.base ?? existing?.baseRefName ?? wt.defaultBranch;
  const flow = new Flow(deps, wt, input, base);
  deps.progress(`fetching origin/${base}`);
  const fetch = await flow.git(["fetch", "origin", base]);
  if (fetch.code !== 0) {
    flow.dispose();
    return failed(`git fetch origin ${base} failed:\n${outputOf(fetch)}`, flow);
  }
  await flow.loadStyle();
  return { wt, flow, existing };
}

/**
 * Commit all changes of a worktree: the pre-commit checks run (the helper fixes failures), the
 * helper writes the message, the commit-msg hook checks it.
 */
export async function gitCommit(input: PrInput, deps: Deps): Promise<PrResult> {
  const started = await start(input, deps);
  if ("ok" in started) return started;
  const { wt, flow } = started;
  try {
    if (!(await flow.hasChanges())) return failed(`nothing to commit in ${wt.root}`, flow, { worktree: wt });
    const commit = await flow.commit();
    if (typeof commit === "string")
      return failed(`${commit}\n\nThe changes are staged in ${wt.root}.`, flow, { worktree: wt });
    const fixed =
      flow.notes.length > 0
        ? `\nThe helper fixed on the way:\n${flow.notes.map((note) => `- ${note}`).join("\n")}`
        : "";
    return {
      ok: true,
      summary: `Committed ${commit.sha} "${commit.subject}" on ${wt.branch}; the pre-commit checks passed.${fixed}`,
      worktree: wt,
      base: flow.base,
      commit,
      notes: flow.notes,
    };
  } finally {
    flow.dispose();
  }
}

type Commit = PrResult["commit"];

async function pushOnce(flow: Flow): Promise<string | undefined> {
  const result = await flow.push();
  return result.code === 0 ? undefined : clipEnd(outputOf(result), 20_000);
}

/**
 * Push the commits of a worktree: the pre-push checks run, and the helper fixes failures (as a new
 * commit, when commit is allowed). Uncommitted changes stay in the worktree.
 */
export async function gitPush(input: PrInput, deps: Deps): Promise<PrResult> {
  const started = await start(input, deps);
  if ("ok" in started) return started;
  const { wt, flow } = started;
  try {
    const failure = await pushStep(flow, wt, undefined, deps);
    if (failure) return failure;
    const dirty = (await flow.hasChanges())
      ? " Uncommitted changes stay in the worktree; git_commit commits them."
      : "";
    const fixed =
      flow.notes.length > 0
        ? `\nThe helper fixed on the way:\n${flow.notes.map((note) => `- ${note}`).join("\n")}`
        : "";
    return {
      ok: true,
      summary: `Pushed ${wt.branch}; the pre-push checks passed.${dirty}${fixed}`,
      worktree: wt,
      base: flow.base,
      notes: flow.notes,
    };
  } finally {
    flow.dispose();
  }
}

/** Stop before a locked step: an error when nothing was done yet, else what was done. */
function stop(step: Step, flow: Flow, wt: Worktree, commit: Commit): PrResult {
  if (!commit) return failed(stoppedAt(step, ""), flow, { worktree: wt, stopped: step });
  const done = `Committed ${commit.sha} "${commit.subject}" on ${wt.branch}. `;
  return {
    ok: true,
    summary: stoppedAt(step, done),
    worktree: wt,
    base: flow.base,
    commit,
    notes: flow.notes,
    stopped: step,
  };
}

/** Commit the changes, when there are any and committing is allowed. */
async function commitStep(
  flow: Flow,
  wt: Worktree,
  allowed: (step: Step) => boolean,
): Promise<{ commit: Commit } | PrResult> {
  if (!(await flow.hasChanges())) return { commit: undefined };
  if (!allowed("commit")) return stop("commit", flow, wt, undefined);
  const made = await flow.commit();
  if (typeof made === "string")
    return failed(`${made}\n\nThe changes are staged in ${wt.root}; nothing was pushed.`, flow, { worktree: wt });
  return { commit: made };
}

/** Push, when there is something to push and pushing is allowed. */
async function pushStep(flow: Flow, wt: Worktree, commit: Commit, deps: Deps): Promise<PrResult | undefined> {
  const { base } = flow;
  const ahead = await flow.ahead();
  if (typeof ahead === "string") return failed(ahead, flow, { worktree: wt });
  if (ahead === 0) {
    return failed(`nothing to do: no changes in ${wt.root} and no commits ahead of origin/${base}`, flow, {
      worktree: wt,
    });
  }
  if (!(deps.allowed ?? (() => true))("push")) return stop("push", flow, wt, commit);
  deps.progress("pre-push: pushing (the hook runs the checks)");
  // A fix of the helper becomes a commit; with commit locked, the push runs once and the helper does not fix.
  const pushed = (deps.allowed ?? (() => true))("commit")
    ? await flow.untilGreen("pre-push", flow.push, flow.commitFix)
    : await pushOnce(flow);
  if (pushed === undefined) return undefined;
  return failed(`The push failed:\n${pushed}\n\nNothing new is on GitHub.`, flow, {
    worktree: wt,
    ...(commit ? { commit } : {}),
  });
}

/** Everything after the push: stop, or open or update the PR. */
async function prStep(
  input: PrInput,
  deps: Deps,
  flow: Flow,
  wt: Worktree,
  commit: Commit,
  existing: PullRequest | undefined,
): Promise<PrResult> {
  const committed = commit ? { commit } : {};
  if (input.updatePr === false)
    return {
      ok: true,
      summary: `Pushed ${wt.branch}.`,
      worktree: wt,
      base: flow.base,
      ...committed,
      notes: flow.notes,
    };
  if (!(deps.allowed ?? (() => true))("pr")) {
    const done = `${commit ? `Committed ${commit.sha} "${commit.subject}"; ` : ""}pushed ${wt.branch}. `;
    return {
      ok: true,
      summary: stoppedAt("pr", done),
      worktree: wt,
      base: flow.base,
      ...committed,
      notes: flow.notes,
      stopped: "pr",
    };
  }
  const pr = await flow.pullRequest(existing);
  if (typeof pr === "string") return failed(`${pr}\n\nThe branch ${wt.branch} is pushed.`, flow, { worktree: wt });
  return success(flow, wt, commit, pr, input.draft === true);
}

/**
 * Commit the changes of a worktree, push them and open (or update) the PR. The checks run as the
 * hooks run them; when they fail, the helper agent fixes the files. The helper also writes the
 * commit message and the PR. The run stops before the first step that \`deps.allowed\` refuses.
 */
export async function gitPr(input: PrInput, deps: Deps): Promise<PrResult> {
  const started = await start(input, deps);
  if ("ok" in started) return started;
  const { wt, flow, existing } = started;
  try {
    const committed = await commitStep(flow, wt, deps.allowed ?? (() => true));
    if ("ok" in committed) return committed;
    const pushFailed = await pushStep(flow, wt, committed.commit, deps);
    if (pushFailed) return pushFailed;
    return await prStep(input, deps, flow, wt, committed.commit, existing);
  } finally {
    flow.dispose();
  }
}
