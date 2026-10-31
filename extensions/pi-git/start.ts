import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Backend } from "./backend.ts";
import { detectCommand } from "./check.ts";
import type { Config } from "./config.ts";
import { clipStart, outputOf, type Runner } from "./exec.ts";
import { commitStyle, defaultBranch, repoName, repoSlug } from "./git.ts";
import { isJj, jj, jjBranch, jjStart, keepingIndex, track } from "./jj.ts";

/** The commit types a branch may start with, as in the git skill. */
export const TYPES = ["feat", "fix", "docs", "refactor", "test", "build", "ci", "chore", "perf"] as const;

export interface StartInput {
  /** The repository: a directory in it, `owner/name`, or `name`. */
  repo: string;
  topic: string;
  /** The branch type; default `feat`. */
  type?: string;
  /** The base branch; default: the default branch. A stacked change names the branch it builds on. */
  base?: string;
  /** Run the repository's setup (devenv, npm ci, uv sync); default: true. */
  setup?: boolean;
}

export interface StartResult {
  ok: boolean;
  summary: string;
  path?: string;
  branch?: string;
  slug?: string;
}

export interface StartDeps {
  run: Runner;
  config: Pick<Config, "worktrees" | "checkTimeout">;
  home: string;
  progress: (text: string) => void;
  signal?: AbortSignal | undefined;
  /** How new worktrees of a repository are made; default: git. */
  backendOf?: (slug: string) => Backend;
}

/** Where the owner keeps main checkouts, searched for `owner/name` and `name`. */
const ROOTS = ["private", "work", "src", "code", "."];

/** pi-git checked the lock itself; the hard stop in the git hooks is for the agents' own commands. */
const OWN = { PI_GIT_SWITCH: "" };

async function git(deps: StartDeps, cwd: string, ...args: string[]): Promise<string | undefined> {
  const result = await deps.run("git", args, { cwd, env: OWN, signal: deps.signal });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function expand(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

async function fromDirectory(deps: StartDeps, dir: string, repo: string): Promise<string | { error: string }> {
  const common = await git(deps, resolve(dir), "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (!common) return { error: `${repo} is not in a git repository` };
  return basename(common) === ".git" ? dirname(common) : common;
}

async function matches(deps: StartDeps, candidate: string, slug: string | undefined): Promise<boolean> {
  if (!existsSync(join(candidate, ".git"))) return false;
  const origin = await git(deps, candidate, "remote", "get-url", "origin");
  return origin !== undefined && (slug === undefined || repoSlug(origin).toLowerCase() === slug.toLowerCase());
}

/** The main checkout of `repo`, or why it cannot be found. */
export async function findMainCheckout(deps: StartDeps, repo: string): Promise<string | { error: string }> {
  const path = expand(repo, deps.home);
  if (isAbsolute(path) || repo.startsWith(".")) return fromDirectory(deps, path, repo);
  const slug = repo.includes("/") ? repo : undefined;
  const name = repo.split("/").at(-1) ?? repo;
  for (const root of ROOTS) {
    const candidate = join(deps.home, root, name);
    if (await matches(deps, candidate, slug)) return candidate;
  }
  return {
    error: `no main checkout of ${repo} in ${ROOTS.map((root) => `~/${root}`).join(", ")}; clone it first (gh repo clone ${repo})`,
  };
}

function checkNames(input: StartInput): string | undefined {
  if (!(TYPES as readonly string[]).includes(input.type ?? "feat")) return `type must be one of ${TYPES.join(", ")}`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.topic) || input.topic.length > 50) {
    return "topic: lower case letters, digits and single hyphens, at most 50 characters (for example login-timeout)";
  }
  return undefined;
}

/** The setup command of a worktree, if it needs one. */
export function setupCommand(root: string): string[] | undefined {
  if (existsSync(join(root, "devenv.nix"))) return ["devenv", "shell", "--", "true"];
  if (existsSync(join(root, "package-lock.json"))) return ["npm", "ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  if (existsSync(join(root, "uv.lock"))) return ["uv", "sync"];
  return undefined;
}

/** Other worktrees of the repository: work in progress the agent should know about. */
async function otherWorktrees(deps: StartDeps, main: string, path: string): Promise<string[]> {
  const list = (await git(deps, main, "worktree", "list", "--porcelain")) ?? "";
  return list
    .split("\n\n")
    .map((block) => ({
      path: /^worktree (.+)$/m.exec(block)?.[1] ?? "",
      branch: /^branch refs\/heads\/(.+)$/m.exec(block)?.[1],
    }))
    .filter((tree) => tree.path !== main && tree.path !== path && tree.path !== "")
    .map((tree) => `${tree.path}${tree.branch ? ` (${tree.branch})` : ""}`);
}

async function facts(deps: StartDeps, path: string, main: string, base: string, defaultName: string) {
  const style = await commitStyle(deps.run, path, base);
  const lines = [
    `Default branch: ${defaultName}${base === defaultName ? "" : `; base: ${base} (stacked: open the PR with base ${base})`}`,
    `Commits: ${style.conventional ? "Conventional Commits" : "the style of the recent subjects"}; recent: ${style.recent
      .slice(0, 3)
      .map((subject) => `"${subject}"`)
      .join(", ")}`,
  ];
  const check = detectCommand(path);
  lines.push(`Checks: ${check ? `\`${check}\` (git_check runs them)` : "none detected"}`);
  const extras = [".github/pull_request_template.md", "CONTRIBUTING.md"].filter((file) => existsSync(join(path, file)));
  if (extras.length > 0) lines.push(`Read: ${extras.join(", ")}`);
  const others = await otherWorktrees(deps, main, path);
  if (others.length > 0) lines.push(`Other worktrees: ${others.join("; ")}`);
  return lines;
}

async function setup(deps: StartDeps, path: string): Promise<string> {
  const command = setupCommand(path);
  if (!command) return "Setup: none needed";
  deps.progress(`setup: ${command.join(" ")}`);
  const result = await deps.run(command[0] as string, command.slice(1), {
    cwd: path,
    timeoutMs: deps.config.checkTimeout * 1000,
    signal: deps.signal,
  });
  if (result.code === 0) return `Setup: \`${command.join(" ")}\` done`;
  const why = result.failure ?? clipStart(outputOf(result).trim(), 600);
  return `Setup: \`${command.join(" ")}\` failed; run it in the worktree before the checks:\n${why}`;
}

interface Plan {
  main: string;
  slug: string;
  branch: string;
  path: string;
  base: string;
  defaultName: string;
  resume: boolean;
  /** What the branch starts from: `origin/<base>`, or the local branch `<base>` (a worktree not pushed yet). */
  from: string;
  /** A jj workspace instead of a git worktree. */
  jj: boolean;
}

/** Everything git_start needs before it adds the worktree, or why it cannot. */
async function plan(input: StartInput, deps: StartDeps): Promise<Plan | StartResult> {
  const invalid = checkNames(input);
  if (invalid) return { ok: false, summary: invalid };
  const main = await findMainCheckout(deps, input.repo);
  if (typeof main !== "string") return { ok: false, summary: main.error };
  const origin = (await git(deps, main, "remote", "get-url", "origin")) ?? "";
  const slug = repoSlug(origin);
  const branch = `${input.type ?? "feat"}/${input.topic}`;
  const path = join(expand(deps.config.worktrees, deps.home), repoName(origin), input.topic);
  deps.progress("fetch origin");
  const fetched = await deps.run("git", ["fetch", "origin", "--prune"], { cwd: main, env: OWN, signal: deps.signal });
  if (fetched.code !== 0) return { ok: false, summary: `git fetch failed:\n${clipStart(outputOf(fetched), 600)}` };
  const defaultName = await defaultBranch(deps.run, main);
  if (existsSync(path)) return existing(deps, path, branch, slug, input.base ?? defaultName);
  const base = input.base ?? defaultName;
  const from = await startPoint(deps, main, base);
  if (!from) return { ok: false, summary: `neither origin/${base} nor a local branch ${base} exists` };
  if (await git(deps, main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)) {
    return { ok: false, summary: `the branch ${branch} exists already; pick another topic, or remove the old branch` };
  }
  const resume = (await git(deps, main, "rev-parse", "--verify", "-q", `origin/${branch}`)) !== undefined;
  return { main, slug, branch, path, base, defaultName, resume, from, jj: deps.backendOf?.(slug) === "jj" };
}

/**
 * Where a new branch starts: the freshly fetched `origin/<base>`, or, for a change stacked on work
 * that is not on GitHub yet, the local branch `<base>` of another worktree.
 */
async function startPoint(deps: StartDeps, main: string, base: string): Promise<string | undefined> {
  if (await git(deps, main, "rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`)) return `origin/${base}`;
  if (await git(deps, main, "rev-parse", "--verify", "-q", `refs/heads/${base}`)) return base;
  return undefined;
}

/** A worktree that exists already on the branch: hand it back, and say when it is behind its base. */
async function existing(
  deps: StartDeps,
  path: string,
  branch: string,
  slug: string,
  base: string,
): Promise<StartResult> {
  const current = isJj(path)
    ? await jjBranch(deps.run, path)
    : await git(deps, path, "symbolic-ref", "--short", "-q", "HEAD");
  if (current !== branch)
    return { ok: false, summary: `${path} exists${current ? ` on ${current}` : ""}; pick another topic` };
  const behind = Number((await git(deps, path, "rev-list", "--count", `HEAD..origin/${base}`)) ?? 0);
  const note = behind > 0 ? `; it is ${behind} commits behind origin/${base}: rebase on it before more work` : "";
  return { ok: true, summary: `The worktree already exists: ${path} (${branch})${note}`, path, branch, slug };
}

/** What the agent needs to know in a jj workspace. */
export const JJ_NOTE =
  "History: jj (a jj workspace). Edit files as usual and do not commit yourself: each of your turns becomes a wip: commit, and git_commit or git_pr turns them into logical commits.";

async function addWorktree(deps: StartDeps, plan: Plan): Promise<string | undefined> {
  const { main, branch, path, resume, from } = plan;
  const args = resume
    ? ["worktree", "add", "--track", "-b", branch, path, `origin/${branch}`]
    : ["worktree", "add", "--no-track", "-b", branch, path, from];
  const added = await deps.run("git", args, { cwd: main, env: OWN, signal: deps.signal });
  return added.code === 0 ? undefined : `git worktree add failed:\n${clipStart(outputOf(added), 600)}`;
}

/** The jj route: a colocated workspace (a git worktree too) with the branch as a bookmark. */
async function addWorkspace(deps: StartDeps, plan: Plan): Promise<string | undefined> {
  const { main, branch, path, resume, from } = plan;
  if (!isJj(main)) {
    // The backend is jj, but the repository has no jj yet: colocate it, git keeps working as before.
    deps.progress("jj git init --colocate: the backend of this repository is jj");
    const init = await keepingIndex(main, () => jj(deps.run, main, ["git", "init", "--colocate"], deps.signal));
    if (init.code !== 0) return `jj git init --colocate failed in ${main}:\n${clipStart(outputOf(init), 600)}`;
  }
  const topic = path.split("/").at(-1) ?? branch;
  const failure = await jjStart(
    deps.run,
    { main, path, topic, branch, from: resume ? `origin/${branch}` : from },
    deps.signal,
  );
  if (failure) return clipStart(failure, 600);
  if (resume) await track(deps.run, path, branch);
  return undefined;
}

/** Creates the worktree of a new change: fetch, worktree and branch from the fresh base, setup. */
export async function gitStart(input: StartInput, deps: StartDeps): Promise<StartResult> {
  const planned = await plan(input, deps);
  if ("ok" in planned) return planned;
  const { main, slug, branch, path, base, defaultName, resume, from } = planned;
  deps.progress(resume ? `worktree on the existing origin/${branch}` : `worktree from ${from}`);
  const failure = planned.jj ? await addWorkspace(deps, planned) : await addWorktree(deps, planned);
  if (failure) return { ok: false, summary: failure };
  const lines = [
    `Worktree: ${path}`,
    `Branch: ${branch}${resume ? ` (continues origin/${branch})` : ` from ${from}`}`,
    ...(planned.jj ? [JJ_NOTE] : []),
    ...(from === base
      ? [`Stacked on the local branch ${base}, which is not on GitHub yet: push it (or open its PR) before this PR.`]
      : []),
    ...(input.setup === false ? [] : [await setup(deps, path)]),
    ...(await facts(deps, path, main, base, defaultName)),
  ];
  return { ok: true, summary: lines.join("\n"), path, branch, slug };
}
