import { basename, dirname } from "node:path";
import type { Runner } from "./exec.ts";

/** What git_pr needs to know about the worktree. */
export interface Worktree {
  root: string;
  branch: string;
  defaultBranch: string;
  /** The repository name: the last part of the origin URL. */
  repo: string;
  /** owner/name from the origin URL. */
  slug: string;
  /** The main checkout that owns the worktree. */
  mainRoot: string;
}

async function git(run: Runner, cwd: string, ...args: string[]): Promise<string | undefined> {
  const result = await run("git", args, { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

/** owner/name from a remote URL: `git@github.com:o/name.git` is `o/name`. */
export function repoSlug(url: string): string {
  const path = url
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/^[^:]+:(?!\/\/)/, "/");
  return path
    .split("/")
    .filter((part) => part !== "")
    .slice(-2)
    .join("/");
}

/** The repository name from a remote URL: `git@github.com:o/name.git` is `name`. */
export function repoName(url: string): string {
  return basename(
    url
      .trim()
      .replace(/\/+$/, "")
      .replace(/\.git$/, ""),
  ).replace(/^.*:/, "");
}

/** The default branch of origin: from refs/remotes/origin/HEAD, else from gh, else main. */
export async function defaultBranch(run: Runner, cwd: string): Promise<string> {
  const head = await git(run, cwd, "symbolic-ref", "--short", "refs/remotes/origin/HEAD");
  if (head) return head.replace(/^origin\//, "");
  const result = await run("gh", ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"], {
    cwd,
  });
  return result.code === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : "main";
}

/**
 * The worktree of `path`, or why git_pr cannot work there: not a repository, the main checkout,
 * a detached HEAD, or the default branch.
 */
export async function inspectWorktree(run: Runner, path: string): Promise<Worktree | string> {
  const root = await git(run, path, "rev-parse", "--show-toplevel");
  if (!root) return `${path} is not in a git repository`;
  const gitDir = await git(run, root, "rev-parse", "--path-format=absolute", "--git-dir");
  const commonDir = await git(run, root, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const origin = await git(run, root, "remote", "get-url", "origin");
  if (!origin) return `${root} has no remote "origin"`;
  const repo = repoName(origin);
  if (gitDir === commonDir) {
    return `${root} is the main checkout. Work in a worktree: git worktree add -b <type>/<topic> ~/.worktrees/${repo}/<topic> origin/<default branch>`;
  }
  const branch = await git(run, root, "symbolic-ref", "--short", "-q", "HEAD");
  if (!branch) return `${root} has a detached HEAD; switch to a branch first`;
  const main = await defaultBranch(run, root);
  if (branch === main) return `${root} is on the default branch ${main}; changes go on a <type>/<topic> branch`;
  const mainRoot = basename(commonDir ?? "") === ".git" ? dirname(commonDir as string) : (commonDir as string);
  return { root, branch, defaultBranch: main, repo, slug: repoSlug(origin), mainRoot };
}

/** Whether the repository uses Conventional Commits (a checker or release-please), and recent subjects. */
export async function commitStyle(
  run: Runner,
  root: string,
  base: string,
): Promise<{ conventional: boolean; recent: string[] }> {
  const files = await git(
    run,
    root,
    "ls-files",
    "--",
    "release-please-config.json",
    ".commitlintrc*",
    "commitlint.config.*",
    ".pre-commit-config.yaml",
    "devenv.nix",
    "lefthook.yml",
  );
  let conventional = /release-please-config\.json|commitlint/.test(files ?? "");
  for (const file of (files ?? "").split("\n").filter((name) => /pre-commit-config|devenv\.nix|lefthook/.test(name))) {
    const text = await git(run, root, "show", `HEAD:${file}`);
    if (text && /convco|commitlint|conventional-pre-commit/.test(text)) conventional = true;
  }
  const log = await git(run, root, "log", "--format=%s", "-20", `origin/${base}`);
  return { conventional, recent: (log ?? "").split("\n").filter((line) => line !== "") };
}

export interface PullRequest {
  number: number;
  url: string;
  title: string;
  body: string;
  baseRefName: string;
  state: string;
}

/** The open PR of a branch, if any. */
export async function findPullRequest(run: Runner, root: string, branch: string): Promise<PullRequest | undefined> {
  const result = await run("gh", ["pr", "view", branch, "--json", "number,url,title,body,baseRefName,state"], {
    cwd: root,
  });
  if (result.code !== 0) return undefined;
  try {
    const pr = JSON.parse(result.stdout) as PullRequest;
    return pr.state === "OPEN" ? pr : undefined;
  } catch {
    return undefined;
  }
}

/** The PR number at the end of a PR URL. */
export function prNumber(url: string): number | undefined {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? Number(match[1]) : undefined;
}
