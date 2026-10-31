import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clipEnd, clipStart, outputOf, type Runner, type RunResult } from "./exec.ts";
import { commitStyle, findPullRequest, inspectWorktree, type PullRequest, prNumber, type Worktree } from "./git.ts";
import { askJson, runHelper } from "./helper.ts";
import { stringField } from "./json.ts";
import { fixPrompt, messagePrompt, messageRetryPrompt, pullRequestPrompt, type Stage } from "./prompts.ts";

export interface PrInput {
  /** A directory in the worktree. */
  path: string;
  /** What the change is for, in the main agent's words. */
  intent: string;
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
}

export interface Deps {
  run: Runner;
  config: Config;
  progress: (text: string) => void;
  signal?: AbortSignal | undefined;
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

  stageAll = async (): Promise<void> => {
    await this.git(["add", "-A"]);
  };

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
    return (await this.gitText("branch", "-r", "--contains", "HEAD")) !== "";
  }

  /** After the helper fixed a pre-push failure: amend an unpushed commit, else add a commit. */
  commitFix = async (): Promise<void> => {
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
    const range = `origin/${this.base}...HEAD`;
    const stacked =
      this.base === this.wt.defaultBranch ? undefined : await findPullRequest(this.deps.run, this.wt.root, this.base);
    const input = [
      stacked
        ? `This PR is stacked on PR #${stacked.number} (${this.base}). Start the body with: "Stacked on #${stacked.number}; merge that first."`
        : "",
      `What the change is for:\n${this.input.intent}`,
      `Branch: ${this.wt.branch} into ${this.base}`,
      `Recent subjects on ${this.base}:\n${this.recent.join("\n")}`,
      `Commits:\n${clipStart(await this.gitText("log", "--format=- %s%n%n%b", `origin/${this.base}..HEAD`), 8000)}`,
      `Changed files:\n${await this.gitText("diff", "--stat", range)}`,
      `Diff:\n${clipStart(await this.gitText("diff", range), MAX_DIFF)}`,
      "Testing: the pre-commit and pre-push hooks of the repository passed locally.",
      this.notes.length > 0 ? `Fixed by the helper on the way:\n${this.notes.join("\n")}` : "",
      this.template() ? `Template:\n${this.template()}` : "",
      existing ? `Current title: ${existing.title}\nCurrent body:\n${existing.body}` : "",
    ]
      .filter((part) => part !== "")
      .join("\n\n");
    this.deps.progress(existing ? `the helper updates PR #${existing.number}` : "the helper writes the PR");
    const text = await askJson(
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
    if (text instanceof Error) return `No PR text: ${text.message}`;
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

/**
 * Commit the changes of a worktree, push them and open (or update) the PR. The checks run as the
 * hooks run them; when they fail, the helper agent fixes the files. The helper also writes the
 * commit message and the PR.
 */
export async function gitPr(input: PrInput, deps: Deps): Promise<PrResult> {
  const wt = await inspectWorktree(deps.run, input.path);
  if (typeof wt === "string") return failed(wt);
  const existing = await findPullRequest(deps.run, wt.root, wt.branch);
  const base = input.base ?? existing?.baseRefName ?? wt.defaultBranch;
  const flow = new Flow(deps, wt, input, base);
  try {
    deps.progress(`fetching origin/${base}`);
    const fetch = await flow.git(["fetch", "origin", base]);
    if (fetch.code !== 0) return failed(`git fetch origin ${base} failed:\n${outputOf(fetch)}`, flow);
    await flow.loadStyle();

    let commit: PrResult["commit"];
    if ((await flow.gitText("status", "--porcelain")) !== "") {
      const made = await flow.commit();
      if (typeof made === "string")
        return failed(`${made}\n\nThe changes are staged in ${wt.root}; nothing was pushed.`, flow, { worktree: wt });
      commit = made;
    }
    if ((await flow.gitText("rev-list", "--count", `origin/${base}..HEAD`)) === "0") {
      return failed(`nothing to do: no changes in ${wt.root} and no commits ahead of origin/${base}`, flow, {
        worktree: wt,
      });
    }

    deps.progress("pre-push: pushing (the hook runs the checks)");
    const pushed = await flow.untilGreen("pre-push", flow.push, flow.commitFix);
    if (pushed !== undefined)
      return failed(`The push failed:\n${pushed}\n\nNothing new is on GitHub.`, flow, {
        worktree: wt,
        ...(commit ? { commit } : {}),
      });

    if (input.updatePr === false) {
      return {
        ok: true,
        summary: `Pushed ${wt.branch}.`,
        worktree: wt,
        base,
        ...(commit ? { commit } : {}),
        notes: flow.notes,
      };
    }
    const pr = await flow.pullRequest(existing);
    if (typeof pr === "string") return failed(`${pr}\n\nThe branch ${wt.branch} is pushed.`, flow, { worktree: wt });
    return success(flow, wt, commit, pr, input.draft === true);
  } finally {
    flow.dispose();
  }
}
