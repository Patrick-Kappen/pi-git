import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { listAttention } from "./attention.ts";
import type { Config } from "./config.ts";
import type { Runner } from "./exec.ts";
import { repoSlug } from "./git.ts";
import { type Entry, entryId, loadEntries, saveEntry } from "./state.ts";

/** At most this many worktree lines, so the result stays small. */
export const MAX_WORKTREES = 40;

export interface StatusDeps {
  run: Runner;
  config: Pick<Config, "worktrees" | "stateDir">;
  home: string;
}

async function git(run: Runner, cwd: string, ...args: string[]): Promise<string | undefined> {
  const result = await run("git", args, { cwd });
  return result.code === 0 ? result.stdout.trim() : undefined;
}

function expand(path: string, home: string): string {
  return path === "~" || path.startsWith("~/") ? join(home, path.slice(1)) : path;
}

function directories(path: string): string[] {
  try {
    return readdirSync(path)
      .map((name) => join(path, name))
      .filter((child) => statSync(child).isDirectory());
  } catch {
    return [];
  }
}

/** One line about a worktree: branch, uncommitted files, unpushed commits, and whether the watcher has it. */
async function describeWorktree(run: Runner, path: string, watched: Map<string, Entry>): Promise<string | undefined> {
  if (!existsSync(join(path, ".git"))) return undefined;
  const branch = (await git(run, path, "symbolic-ref", "--short", "-q", "HEAD")) ?? "detached";
  const dirty = ((await git(run, path, "status", "--porcelain")) ?? "").split("\n").filter(Boolean).length;
  const upstream = await git(run, path, "rev-parse", "--abbrev-ref", "@{u}");
  const ahead = upstream ? Number((await git(run, path, "rev-list", "--count", "@{u}..HEAD")) ?? 0) : undefined;
  const entry = watched.get(path);
  const parts = [
    dirty > 0 ? `${dirty} uncommitted` : "",
    ahead === undefined ? "not pushed" : ahead > 0 ? `${ahead} unpushed` : "",
    entry ? `PR #${entry.number} ${entry.status}` : "no PR in the watcher",
  ].filter(Boolean);
  return `- ${basename(dirname(path))}/${basename(path)} (${branch}): ${parts.join(", ")}`;
}

/** Everything in progress: watched PRs, what needs the user, and the worktrees. Reads only. */
export async function gitStatus(deps: StatusDeps): Promise<string> {
  const entries = loadEntries(deps.config.stateDir);
  const watched = new Map(entries.map((entry) => [entry.worktree, entry]));
  const sections: string[] = [];

  sections.push(
    entries.length === 0
      ? "Watched PRs: none"
      : [
          "Watched PRs:",
          ...entries.map(
            (e) => `- ${e.repo}#${e.number} ${e.status}${e.attempts > 0 ? `, ${e.attempts} fixes` : ""}: ${e.url}`,
          ),
        ].join("\n"),
  );

  const attention = listAttention(deps.config.stateDir);
  if (attention.length > 0) sections.push(["Needs the user:", ...attention.map((item) => `- ${item.text}`)].join("\n"));

  const root = expand(deps.config.worktrees, deps.home);
  const lines: string[] = [];
  for (const repo of directories(root)) {
    for (const path of directories(repo)) {
      const line = await describeWorktree(deps.run, path, watched);
      if (line) lines.push(line);
    }
  }
  const shown =
    lines.length > MAX_WORKTREES
      ? [...lines.slice(0, MAX_WORKTREES), `- and ${lines.length - MAX_WORKTREES} more`]
      : lines;
  sections.push(lines.length === 0 ? `Worktrees: none in ${root}` : [`Worktrees in ${root}:`, ...shown].join("\n"));
  return sections.join("\n\n");
}

interface PrView {
  number: number;
  url: string;
  title: string;
  state: string;
  headRefName: string;
  baseRefName: string;
}

/** The worktree that has `branch` checked out, from `git worktree list` of the repository. */
export async function worktreeOf(
  run: Runner,
  cwd: string,
  branch: string,
): Promise<{ path: string; main: string } | undefined> {
  const list = (await git(run, cwd, "worktree", "list", "--porcelain")) ?? "";
  const blocks = list.split("\n\n").filter(Boolean);
  const main = /^worktree (.+)$/m.exec(blocks[0] ?? "")?.[1];
  for (const block of blocks.slice(1)) {
    if (new RegExp(`^branch refs/heads/${branch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m").test(block)) {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      if (path && main) return { path, main };
    }
  }
  return undefined;
}

/** Hands a PR made outside git_pr to the watcher. Needs a worktree that has its branch checked out. */
export async function gitWatch(
  deps: StatusDeps,
  input: { pr: string; path: string; sessionId: string; quiet?: boolean },
  now = new Date(),
): Promise<{ ok: boolean; summary: string; entry?: Entry }> {
  const origin = await git(deps.run, input.path, "remote", "get-url", "origin");
  if (!origin) return { ok: false, summary: `${input.path} is not in a git repository with an origin` };
  const view = await deps.run(
    "gh",
    ["pr", "view", input.pr, "--json", "number,url,title,state,headRefName,baseRefName"],
    { cwd: input.path },
  );
  if (view.code !== 0) return { ok: false, summary: `gh pr view ${input.pr} failed: ${view.stderr.trim()}` };
  const pr = JSON.parse(view.stdout) as PrView;
  if (pr.state !== "OPEN")
    return { ok: false, summary: `PR #${pr.number} is ${pr.state.toLowerCase()}; only open PRs are watched` };
  const tree = await worktreeOf(deps.run, input.path, pr.headRefName);
  if (!tree) {
    return {
      ok: false,
      summary: `no worktree has ${pr.headRefName} checked out; the watcher needs one to fix CI. Add it with git worktree add ~/.worktrees/<repo>/<topic> ${pr.headRefName}`,
    };
  }
  const repo = repoSlug(origin);
  const id = entryId(repo, pr.number);
  const previous = loadEntries(deps.config.stateDir).find((entry) => entry.id === id);
  const entry: Entry = {
    id,
    repo,
    number: pr.number,
    url: pr.url,
    worktree: tree.path,
    mainRoot: tree.main,
    branch: pr.headRefName,
    base: pr.baseRefName,
    intent: pr.title,
    sessionId: input.sessionId,
    status: "watching",
    attempts: previous?.attempts ?? 0,
    errors: 0,
    notes: previous?.notes ?? [],
    updated: now.toISOString(),
    ...(input.quiet ? { quiet: true } : {}),
  };
  saveEntry(deps.config.stateDir, entry);
  return {
    ok: true,
    summary: `The watcher follows ${repo}#${pr.number} (${tree.path}) and reports back when it is green, merged or needs you.`,
    entry,
  };
}
