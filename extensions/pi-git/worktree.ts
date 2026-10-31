import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { clipEnd, outputOf, type Runner } from "./exec.ts";
import { defaultBranch, repoName } from "./git.ts";

export interface WorktreeInput {
  /** A directory in the repository (the main checkout or a worktree). */
  path: string;
  /** Short, lower case, with `-`: what the change is about. */
  topic: string;
  /** The branch type; default `feat`. */
  type?: string;
  /** The branch to start from; default: the default branch. */
  base?: string;
}

export interface WorktreeResult {
  ok: boolean;
  summary: string;
  path?: string;
  branch?: string;
}

export interface WorktreeDeps {
  run: Runner;
  config: Config;
  progress: (text: string) => void;
  signal?: AbortSignal | undefined;
}

const TOPIC = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TYPE = /^[a-z][a-z0-9]{0,15}$/;

/** The setup a new worktree needs: the dev shell, or the dependencies; undefined when none is known. */
export function setupCommand(dir: string): [string, string[]] | undefined {
  if (existsSync(join(dir, "devenv.nix"))) return ["devenv", ["shell", "--", "true"]];
  if (existsSync(join(dir, "package-lock.json"))) return ["npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"]];
  if (existsSync(join(dir, "uv.lock"))) return ["uv", ["sync"]];
  return undefined;
}

function failed(summary: string): WorktreeResult {
  return { ok: false, summary: `git_worktree: ${summary}` };
}

/**
 * Create `<worktrees>/<repo>/<topic>` on a new branch `<type>/<topic>`, from a freshly fetched
 * `origin/<base>`, and run its setup.
 */
export async function gitWorktree(input: WorktreeInput, deps: WorktreeDeps): Promise<WorktreeResult> {
  const type = input.type ?? "feat";
  if (!TOPIC.test(input.topic)) return failed(`the topic "${input.topic}" must be lower case letters, digits and -`);
  if (!TYPE.test(type)) return failed(`the type "${type}" must be a lower case word such as feat or fix`);
  // pi-git checked the lock itself; the hard stop in the git hooks is for the agents' own commands.
  const git = (cwd: string, ...args: string[]) =>
    deps.run("git", args, { cwd, env: { PI_GIT_SWITCH: "" }, signal: deps.signal });
  const common = await git(input.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  if (common.code !== 0) return failed(`${input.path} is not in a git repository`);
  const mainRoot = common.stdout.trim().replace(/\/\.git$/, "");
  const origin = await git(mainRoot, "remote", "get-url", "origin");
  if (origin.code !== 0) return failed(`${mainRoot} has no remote "origin"`);
  const repo = repoName(origin.stdout);
  const branch = `${type}/${input.topic}`;
  const dir = join(deps.config.worktrees, repo, input.topic);
  if (existsSync(dir)) return failed(`${dir} exists already; pick another topic, or work there`);
  if ((await git(mainRoot, "rev-parse", "--verify", "-q", `refs/heads/${branch}`)).code === 0) {
    return failed(`the branch ${branch} exists already; pick another topic`);
  }
  const base = input.base ?? (await defaultBranch(deps.run, mainRoot));
  deps.progress(`fetching origin/${base}`);
  const fetch = await git(mainRoot, "fetch", "origin", base);
  if (fetch.code !== 0) return failed(`git fetch origin ${base} failed:\n${clipEnd(outputOf(fetch), 4000)}`);
  deps.progress(`creating ${dir} on ${branch}`);
  const add = await git(mainRoot, "worktree", "add", "-b", branch, dir, `origin/${base}`);
  if (add.code !== 0) return failed(`git worktree add failed:\n${clipEnd(outputOf(add), 4000)}`);
  const setup = setupCommand(dir);
  let setupText = "No setup needed.";
  if (setup) {
    deps.progress(`setup: ${setup[0]} ${setup[1].join(" ")}`);
    const result = await deps.run(setup[0], setup[1], {
      cwd: dir,
      timeoutMs: deps.config.checkTimeout * 1000,
      signal: deps.signal,
    });
    setupText =
      result.code === 0
        ? `Setup done (${setup[0]} ${setup[1].join(" ")}).`
        : `The setup (${setup[0]} ${setup[1].join(" ")}) failed; the worktree is there anyway:\n${clipEnd(outputOf(result), 2000)}`;
  }
  return {
    ok: true,
    summary: `Created the worktree ${dir} on ${branch} from origin/${base}. ${setupText}\nWork there: give tools paths in ${dir}.`,
    path: dir,
    branch,
  };
}
