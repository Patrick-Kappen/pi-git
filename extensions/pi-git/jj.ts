import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { outputOf, type Runner, type RunResult } from "./exec.ts";

/**
 * The jj route: a repository with a `.jj` directory next to `.git` (colocated) works with jj.
 * Workspaces are git worktrees (`jj workspace add --colocate`), so the git hooks and `git push`
 * still run; jj keeps the history: every agent turn is one work-in-progress commit, and git_commit
 * turns the work in progress into logical commits.
 */

/** pi-git checked the lock itself; the hard stop in the git hooks is for the agents' own commands. */
const OWN = { PI_GIT_SWITCH: "" };

/** A work-in-progress commit: its description starts with this. */
export const WIP = "wip:";

export function jj(run: Runner, cwd: string, args: readonly string[], signal?: AbortSignal): Promise<RunResult> {
  return run("jj", ["--no-pager", "--color=never", ...args], { cwd, env: OWN, signal });
}

async function jjText(run: Runner, cwd: string, args: readonly string[]): Promise<string | undefined> {
  const result = await jj(run, cwd, args);
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** Template output of `jj log` for a revset, one line per commit; empty when the revset is empty or invalid. */
async function logLines(run: Runner, cwd: string, revset: string, template: string): Promise<string[]> {
  const text = await jjText(run, cwd, ["log", "--no-graph", "-r", revset, "-T", `${template} ++ "\\n"`]);
  return (text ?? "").split("\n").filter((line) => line !== "");
}

/** A string literal for a revset or fileset. */
export function quote(text: string): string {
  return JSON.stringify(text);
}

/** Whether the worktree root (or main checkout) uses jj. */
export function isJj(root: string): boolean {
  return existsSync(join(root, ".jj"));
}

/** The jj workspace a path is in: the nearest directory with `.jj` and `.git`. */
export function jjRootOf(path: string): string | undefined {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, ".jj")) && existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** A jj workspace that is a git worktree (`.git` is a file), not a main checkout. */
export function isWorkspace(root: string): boolean {
  try {
    return isJj(root) && statSync(join(root, ".git")).isFile();
  } catch {
    return false;
  }
}

/** Everything the work builds on: the default branch, what is on GitHub, and the base of a stacked change. */
function protectedSet(base?: string): string {
  const stacked = base ? ` | bookmarks(exact:${quote(base)})` : "";
  return `::(trunk() | remote_bookmarks(remote=exact:"origin")${stacked})`;
}

/** The commits of this workspace that are not on GitHub or the base yet. */
function workSet(base?: string): string {
  return `(::@ ~ ${protectedSet(base)})`;
}

const DESCRIBED = `(description(regex:"^.") ~ description(glob:${quote(`${WIP}*`)}))`;

/** The work in progress: commits without a description or with a wip: one, and the working copy. */
export function wipSet(base?: string): string {
  return `((${workSet(base)} ~ ${DESCRIBED}) | @)`;
}

/** The logical commits: described, not wip:, not on GitHub yet. */
function loggedSet(base?: string): string {
  return `(${workSet(base)} & ${DESCRIBED})`;
}

/** How many commits of work in progress (turns, and the working copy) change something. */
export async function countWork(run: Runner, root: string, base?: string): Promise<number> {
  return (await logLines(run, root, `(${wipSet(base)}) ~ empty()`, `"x"`)).length;
}

/** Whether the workspace has work in progress that is not committed yet. */
export async function hasWork(run: Runner, root: string, base?: string): Promise<boolean> {
  return (await countWork(run, root, base)) > 0;
}

/** The branch of a workspace: its bookmark named `<type>/<workspace>`, else the newest bookmark ahead of trunk. */
export async function jjBranch(run: Runner, root: string): Promise<string | undefined> {
  const names = async (revset: string) =>
    (await logLines(run, root, revset, `local_bookmarks.map(|b| b.name()).join("\\n")`)).flatMap((line) =>
      line.split("\n"),
    );
  const topic = basename(root);
  const named = (await names(`bookmarks(glob:${quote(`*/${topic}`)}) & ::@`)).find(
    (name) => name.endsWith(`/${topic}`) && !name.slice(0, -topic.length - 1).includes("/"),
  );
  return named ?? (await names("heads(bookmarks() & (::@ ~ ::trunk()))"))[0];
}

/**
 * The end of an agent turn: name the working-copy commit after the turn (when the agent did not) and
 * start a new one, so every turn is one commit. Nothing happens when the turn changed nothing.
 */
export async function wipSnapshot(run: Runner, root: string, label: string): Promise<boolean> {
  const [state] = await logLines(run, root, "@", `if(empty, "empty", if(description, "described", "open"))`);
  if (state === undefined || state === "empty") return false;
  if (state === "open") {
    const line = label.split("\n")[0]?.trim().slice(0, 72) || "agent turn";
    await jj(run, root, ["describe", "-m", `${WIP} ${line}`]);
  }
  return (await jj(run, root, ["new"])).code === 0;
}

/**
 * Collect the work in progress in the working-copy commit, without a description, so git sees it as
 * uncommitted changes (`git add -A` stages it for the hooks). A string is why not.
 */
export async function gatherWork(run: Runner, root: string, base?: string): Promise<string | undefined> {
  const wip = wipSet(base);
  const above = await logLines(
    run,
    root,
    `(roots(${wip})::@) ~ (${wip})`,
    `commit_id.short() ++ " " ++ description.first_line()`,
  );
  if (above.length > 0) {
    return `described commits sit on top of the work in progress:\n${above.join("\n")}\nMove them below it (jj rebase), or give the work in progress a description, then try again`;
  }
  if ((await logLines(run, root, `(${wip}) ~ @`, `"x"`)).length > 0) {
    const squash = await jj(run, root, [
      "squash",
      "--from",
      `(${wip}) ~ @`,
      "--into",
      "@",
      "--use-destination-message",
    ]);
    if (squash.code !== 0) return `jj squash failed:\n${outputOf(squash)}`;
  }
  const described = await jj(run, root, ["describe", "-m", ""]);
  return described.code === 0 ? undefined : `jj describe failed:\n${outputOf(described)}`;
}

/** The files the working-copy commit changes, relative to the workspace root. */
export async function changedFiles(run: Runner, root: string): Promise<string[]> {
  const text = await jjText(run, root, ["diff", "-r", "@", "--name-only"]);
  return (text ?? "").split("\n").filter((line) => line !== "");
}

export interface PlannedCommit {
  files: string[];
  message: string;
}

/** One commit of the helper's answer, checked against the changed files and the files of earlier commits. */
function parseCommit(
  raw: unknown,
  index: number,
  files: readonly string[],
  seen: Map<string, number>,
): PlannedCommit | Error {
  const commit = raw as { files?: unknown; subject?: unknown; body?: unknown };
  if (!Array.isArray(commit.files) || commit.files.length === 0 || typeof commit.subject !== "string")
    return new Error(`commit ${index + 1} needs "files" and a "subject"`);
  for (const file of commit.files as string[]) {
    if (!files.includes(file)) return new Error(`commit ${index + 1} names ${file}, which is not changed`);
    const earlier = seen.get(file);
    if (earlier !== undefined) return new Error(`${file} is in commits ${earlier + 1} and ${index + 1}`);
    seen.set(file, index);
  }
  const body = typeof commit.body === "string" ? commit.body.trim() : "";
  const subject = commit.subject.trim();
  return { files: commit.files as string[], message: body === "" ? `${subject}\n` : `${subject}\n\n${body}\n` };
}

/** The helper's split of the changes into logical commits; an Error says what is wrong with it. */
export function parsePlan(value: unknown, files: readonly string[]): PlannedCommit[] | Error {
  const commits = (value as { commits?: unknown } | undefined)?.commits;
  if (!Array.isArray(commits) || commits.length === 0) return new Error('the answer has no "commits" list');
  const seen = new Map<string, number>();
  const plan: PlannedCommit[] = [];
  for (const [index, raw] of commits.entries()) {
    const commit = parseCommit(raw, index, files, seen);
    if (commit instanceof Error) return commit;
    plan.push(commit);
  }
  const missing = files.filter((file) => !seen.has(file));
  return missing.length > 0 ? new Error(`no commit has ${missing.join(", ")}`) : plan;
}

/**
 * Make the planned commits from the working-copy commit: split off every commit but the last, give
 * the rest the last message, and start a new working-copy commit. A string is why it failed.
 */
export async function applyPlan(
  run: Runner,
  root: string,
  plan: readonly PlannedCommit[],
): Promise<string | undefined> {
  for (const commit of plan.slice(0, -1)) {
    const files = commit.files.map((file) => `root-file:${quote(file)}`);
    const split = await jj(run, root, ["split", "-r", "@", "-m", commit.message, "--", ...files]);
    if (split.code !== 0) return `jj split failed:\n${outputOf(split)}`;
  }
  const last = plan.at(-1);
  if (!last) return "no commits planned";
  const describe = await jj(run, root, ["describe", "-r", "@", "-m", last.message]);
  if (describe.code !== 0) return `jj describe failed:\n${outputOf(describe)}`;
  const made = await jj(run, root, ["new"]);
  return made.code === 0 ? undefined : `jj new failed:\n${outputOf(made)}`;
}

/** The newest logical commit, the one the branch points at for a push; a string says why there is none. */
export async function pushTarget(run: Runner, root: string, base?: string): Promise<string | undefined | Error> {
  const heads = await logLines(run, root, `heads(${loggedSet(base)})`, "commit_id");
  if (heads.length > 1) return new Error(`the logical commits have ${heads.length} heads; put them in one line first`);
  return heads[0];
}

/** Point the branch at a commit; git sees it as the branch at once. */
export async function setBookmark(run: Runner, root: string, branch: string, rev: string): Promise<RunResult> {
  return jj(run, root, ["bookmark", "set", branch, "-r", rev, "--allow-backwards"]);
}

/** After a push: jj follows the branch on GitHub, so later fetches move it. */
export async function track(run: Runner, root: string, branch: string): Promise<void> {
  await jj(run, root, ["bookmark", "track", branch, "--remote=origin"]);
}

/** Whether a commit is already on GitHub. */
export async function onRemote(run: Runner, root: string, rev: string): Promise<boolean> {
  return (await logLines(run, root, `${rev} & ::remote_bookmarks(remote=exact:"origin")`, `"x"`)).length > 0;
}

/**
 * The branch on GitHub has commits the workspace lacks (the watcher pushed): fetch them and rebase
 * the workspace's own commits on them. On conflicts everything is put back. A string is why it failed.
 */
export async function rebaseOnRemote(run: Runner, root: string, branch: string): Promise<string | undefined> {
  const before = await jjText(run, root, ["op", "log", "-n", "1", "--no-graph", "-T", "id"]);
  const fetch = await jj(run, root, ["git", "fetch", "--branch", branch]);
  if (fetch.code !== 0) return `jj git fetch failed:\n${outputOf(fetch)}`;
  const remote = `remote_bookmarks(exact:${quote(branch)}, exact:"origin")`;
  const rebase = await jj(run, root, ["rebase", "-s", `roots(${remote}..@)`, "-d", remote]);
  const conflicts = await logLines(run, root, `(${remote}::@) & conflicts()`, "commit_id.short()");
  if (rebase.code === 0 && conflicts.length === 0) return undefined;
  if (before) await jj(run, root, ["op", "restore", before]);
  return rebase.code !== 0
    ? `jj rebase failed:\n${outputOf(rebase)}`
    : "the commits on GitHub conflict with the commits of the workspace; nothing was changed";
}

/**
 * Bring a workspace to the head of its PR for a fix by the watcher: no work in progress, the branch
 * at the head, and the working copy on it. A string is why not.
 */
export async function jjAtHead(run: Runner, root: string, branch: string, head: string): Promise<string | undefined> {
  if (await hasWork(run, root)) return `the workspace ${root} has work in progress`;
  await jj(run, root, ["git", "fetch", "--branch", branch]);
  const [local] = await logLines(run, root, `bookmarks(exact:${quote(branch)})`, "commit_id");
  if (local !== head) {
    const behind = local === undefined || (await logLines(run, root, `${local} & ::${head}`, `"x"`)).length > 0;
    if (!behind) return `the workspace has commits that are not on GitHub (${local?.slice(0, 8)})`;
    await setBookmark(run, root, branch, head);
  }
  const [parent] = await logLines(run, root, "@-", "commit_id");
  if (parent === head) return undefined;
  const moved = await jj(run, root, ["new", head]);
  return moved.code === 0 ? undefined : `could not move the workspace to ${head.slice(0, 8)}: ${outputOf(moved)}`;
}

/** A new workspace for a change: a git worktree from the base, with the branch as a bookmark. */
export async function jjStart(
  run: Runner,
  input: { main: string; path: string; topic: string; branch: string; from: string },
  signal?: AbortSignal,
): Promise<string | undefined> {
  const [name, remote] = input.from.startsWith("origin/") ? [input.from.slice(7), "origin"] : [input.from, undefined];
  const from = remote ? `remote_bookmarks(exact:${quote(name)}, exact:"origin")` : `bookmarks(exact:${quote(name)})`;
  // Unlike git worktree add, jj does not create the parent directories.
  mkdirSync(dirname(input.path), { recursive: true });
  const added = await jj(
    run,
    input.main,
    ["workspace", "add", "--colocate", "--name", input.topic, "-r", from, input.path],
    signal,
  );
  if (added.code !== 0) return `jj workspace add failed:\n${outputOf(added)}`;
  const bookmark = await jj(run, input.path, ["bookmark", "create", input.branch, "-r", "@-"], signal);
  return bookmark.code === 0 ? undefined : `jj bookmark create failed:\n${outputOf(bookmark)}`;
}

/** After the merge: forget the workspace and delete the bookmark (the directory is removed with git). */
export async function jjForget(run: Runner, main: string, worktree: string, branch: string): Promise<void> {
  const names = await jjText(run, main, ["workspace", "list", "-T", `name ++ "\\n"`]);
  const name = basename(worktree);
  if ((names ?? "").split("\n").includes(name)) await jj(run, main, ["workspace", "forget", name]);
  await jj(run, main, ["bookmark", "delete", branch]);
}

/** For git_status: the branch, the commits in progress, and the logical commits not on GitHub. */
export async function jjSummary(
  run: Runner,
  root: string,
): Promise<{ branch: string; wip: number; unpushed: number; pushed: boolean }> {
  const branch = (await jjBranch(run, root)) ?? "no branch";
  const wip = (await logLines(run, root, `(${wipSet()}) ~ empty()`, `"x"`)).length;
  const unpushed = (await logLines(run, root, loggedSet(), `"x"`)).length;
  const pushed =
    (await logLines(run, root, `remote_bookmarks(exact:${quote(branch)}, exact:"origin")`, `"x"`)).length > 0;
  return { branch, wip, unpushed, pushed };
}
