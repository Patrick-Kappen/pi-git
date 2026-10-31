import type { Step } from "./switch.ts";

/**
 * In a helper process that fixes files, git_pr and the watcher do every git and GitHub step
 * themselves. The helper may read with git (status, diff, log, show) but not change the history,
 * the branches, the remote or GitHub.
 */
const BLOCKED_GIT = new Set([
  "add",
  "am",
  "branch",
  "checkout",
  "cherry-pick",
  "clean",
  "commit",
  "fetch",
  "merge",
  "pull",
  "push",
  "rebase",
  "reset",
  "restore",
  "revert",
  "rm",
  "stash",
  "switch",
  "tag",
  "update-ref",
  "worktree",
]);

/** Options of git that take a value before the subcommand. */
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

const WRAPPERS = new Set(["sudo", "env", "command", "exec", "time", "nohup", "nice", "builtin"]);

/** Split a command line at `&&`, `||`, `;`, `|`, `&`, newlines and substitutions, outside quotes. */
export function commandsOf(line: string): string[][] {
  const commands: string[][] = [];
  const tokens = line.match(/'[^']*'?|"(?:[^"\\]|\\[\s\S])*"?|&&|\|\||\$\(|[;|&\n()`]|[^\s'";|&$\n()`]+|\$|\s+/g) ?? [];
  let words: string[] = [];
  let word = "";
  const endWord = () => {
    if (word !== "") words.push(word);
    word = "";
  };
  for (const token of tokens) {
    if (/^(?:&&|\|\||\$\(|[;|&\n()`])$/.test(token)) {
      endWord();
      if (words.length > 0) commands.push(words);
      words = [];
    } else if (/^\s+$/.test(token)) {
      endWord();
    } else {
      word += token.replace(/^'([\s\S]*?)'?$/, "$1").replace(/^"([\s\S]*?)"?$/, "$1");
    }
  }
  endWord();
  if (words.length > 0) commands.push(words);
  return commands.map(stripPrefixes).filter((command) => command.length > 0);
}

function stripPrefixes(words: string[]): string[] {
  let i = 0;
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] as string) || WRAPPERS.has(words[i] as string)))
    i++;
  return words.slice(i);
}

function gitSubcommand(words: readonly string[]): string | undefined {
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    if (GIT_OPTIONS_WITH_VALUE.has(word)) i++;
    else if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/** Why a helper may not run a bash line, or undefined when it may. */
export function blockedForHelper(line: string): string | undefined {
  for (const words of commandsOf(line)) {
    const program = (words[0] as string).replace(/^.*\//, "");
    if (program === "git") {
      const sub = gitSubcommand(words);
      if (sub && BLOCKED_GIT.has(sub)) return `git ${sub}`;
    }
    if (program === "jj") {
      const change = jjCommand(words);
      if (change) return change.what;
    }
    if (program === "gh") return "gh";
  }
  return undefined;
}

/** Options of jj that take a value before the subcommand. */
const JJ_OPTIONS_WITH_VALUE = new Set([
  "-R",
  "--repository",
  "--at-operation",
  "--at-op",
  "--color",
  "--config",
  "--config-toml",
  "--config-file",
]);

/** jj commands that only read (every jj command snapshots the working copy, which changes no history). */
const READ_JJ = new Set([
  "diff",
  "evolog",
  "help",
  "interdiff",
  "log",
  "obslog",
  "root",
  "show",
  "st",
  "status",
  "version",
]);

/** jj commands that read with some subcommands, and the subcommands that read. */
const READ_JJ_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  bookmark: new Set(["list", "l"]),
  b: new Set(["list", "l"]),
  config: new Set(["get", "list", "path"]),
  file: new Set(["annotate", "list", "show"]),
  git: new Set(["fetch"]),
  op: new Set(["diff", "log", "show"]),
  operation: new Set(["diff", "log", "show"]),
  tag: new Set(["list", "l"]),
  workspace: new Set(["list", "root"]),
};

/** The step of a jj command that changes something: push, worktree (workspaces, bookmarks), or commit. */
function jjStep(sub: string, action: string): Step {
  if (sub === "git" && action === "push") return "push";
  if (sub === "workspace" || sub === "bookmark" || sub === "b") return "worktree";
  return "commit";
}

/** A jj command that changes something: what it is, its step, and the directory of `-R`. */
function jjCommand(words: readonly string[]): { what: string; step: Step; repository?: string } | undefined {
  let repository: string | undefined;
  const rest: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    if (word === "-R" || word === "--repository") repository = words[++i];
    else if (JJ_OPTIONS_WITH_VALUE.has(word)) i++;
    else if (!word.startsWith("-")) rest.push(word);
  }
  const [sub, action = ""] = rest;
  if (sub === undefined || READ_JJ.has(sub)) return undefined;
  const reads = READ_JJ_SUBCOMMANDS[sub];
  if (reads?.has(action) || (sub === "git" && action === "remote" && rest[2] === "list")) return undefined;
  const what = `jj ${sub}${reads ? ` ${action}` : ""}`.trim();
  return { what, step: jjStep(sub, action), ...(repository ? { repository } : {}) };
}

/** git subcommands that only read. */
const READ_GIT = new Set([
  "annotate",
  "blame",
  "cat-file",
  "check-attr",
  "check-ignore",
  "cherry",
  "count-objects",
  "describe",
  "diff",
  "fetch",
  "for-each-ref",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "merge-base",
  "name-rev",
  "range-diff",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "var",
  "verify-commit",
  "version",
  "whatchanged",
]);

/** git subcommands that read with some arguments: the first argument (or none) that keeps them reading. */
const READ_SUBCOMMANDS: Record<string, ReadonlySet<string>> = {
  notes: new Set(["list", "show"]),
  reflog: new Set(["", "show"]),
  remote: new Set(["", "-v", "--verbose", "get-url", "show"]),
  stash: new Set(["list", "show"]),
  submodule: new Set(["status", "summary"]),
  worktree: new Set(["list"]),
};

/** Flags that change something: of `git branch`, and of `git tag`. */
const WRITE_FLAGS = {
  branch: /^(-[dDmMcCfu]|--(delete|move|copy|force|set-upstream-to|unset-upstream|edit-description))(=|$)/,
  tag: /^(-[dfasmu]|--(delete|force|annotate|sign|message|local-user))(=|$)/,
};
/** Flags of `git branch` and `git tag` whose next word is a value, not a name. */
const BRANCH_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
]);

function branchOrTagWrites(sub: "branch" | "tag", args: readonly string[]): boolean {
  if (args.some((arg) => WRITE_FLAGS[sub].test(arg))) return true;
  if (args.includes("-l") || args.includes("--list")) return false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (BRANCH_VALUE_FLAGS.has(arg)) i++;
    else if (!arg.startsWith("-")) return true;
  }
  return false;
}

function configWrites(args: readonly string[]): boolean {
  if (args.some((arg) => /^--(get|get-all|get-regexp|get-urlmatch|list|show-origin|show-scope)$|^-l$/.test(arg)))
    return false;
  return args.filter((arg) => !arg.startsWith("-")).length !== 1;
}

/** Whether a git command (the words after `git` and its options) changes something. */
export function gitWrites(sub: string, args: readonly string[]): boolean {
  if (READ_GIT.has(sub)) return false;
  const reads = READ_SUBCOMMANDS[sub];
  if (reads) return !reads.has(args[0] ?? "");
  if (sub === "branch" || sub === "tag") return branchOrTagWrites(sub, args);
  if (sub === "config") return configWrites(args);
  return true;
}

/** gh commands that only read: `<group> <command>`, or a group where every command reads. */
const READ_GH = new Set([
  "auth status",
  "browse",
  "cache list",
  "gist list",
  "gist view",
  "issue list",
  "issue status",
  "issue view",
  "label list",
  "pr checks",
  "pr diff",
  "pr list",
  "pr status",
  "pr view",
  "release list",
  "release view",
  "repo list",
  "repo view",
  "ruleset check",
  "ruleset list",
  "ruleset view",
  "run list",
  "run view",
  "run watch",
  "search",
  "status",
  "workflow list",
  "workflow view",
]);

/** Whether a gh command changes something. `gh api` reads unless it sets a method or fields. */
export function ghWrites(args: readonly string[]): boolean {
  const words = args.filter((arg) => !arg.startsWith("-"));
  const [group = "", command = ""] = words;
  if (group === "") return false;
  if (group === "api") {
    const method = args.findIndex((arg) => arg === "-X" || arg === "--method");
    const setsMethod = method !== -1 && (args[method + 1] ?? "").toUpperCase() !== "GET";
    return setsMethod || args.some((arg) => /^(-[fF]|--(field|raw-field|input)|-X.+|--method=(?!GET$).+)/i.test(arg));
  }
  return !READ_GH.has(group) && !READ_GH.has(`${group} ${command}`);
}

/** The step a git subcommand belongs to: pushing, starting work (worktrees and branches), or committing. */
export function gitStep(sub: string): Step {
  if (sub === "push") return "push";
  if (sub === "worktree" || sub === "branch") return "worktree";
  return "commit";
}

/** A git or gh command that changes something, and where. */
export interface GitChange {
  /** For messages: `git commit`, `gh pr create`. */
  what: string;
  /** The lock that applies: gh changes are `pr`. */
  step: Step;
  /** The directory it runs in. */
  dir: string;
  /** The repository, when the command names it (`gh -R owner/name`). */
  slug?: string;
}

function resolveDir(path: string, cwd: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  if (path.startsWith("/")) return path;
  return `${cwd.replace(/\/$/, "")}/${path}`;
}

function gitChange(words: readonly string[], dir: string, home: string): GitChange | undefined {
  let where = dir;
  for (let i = 1; i < words.length; i++) {
    const word = words[i] as string;
    if (word === "-C") {
      where = resolveDir(words[++i] ?? ".", where, home);
    } else if (GIT_OPTIONS_WITH_VALUE.has(word)) {
      i++;
    } else if (!word.startsWith("-")) {
      return gitWrites(word, words.slice(i + 1)) ? { what: `git ${word}`, step: gitStep(word), dir: where } : undefined;
    }
  }
  return undefined;
}

/** jj runs no git hooks, so this is the only stop for jj in a locked repository. */
function jjChange(words: readonly string[], dir: string, home: string): GitChange | undefined {
  const command = jjCommand(words);
  if (!command) return undefined;
  const where = command.repository ? resolveDir(command.repository, dir, home) : dir;
  return { what: command.what, step: command.step, dir: where };
}

function ghChange(words: readonly string[], dir: string): GitChange | undefined {
  const args = words.slice(1);
  if (!ghWrites(args)) return undefined;
  const repo = args.findIndex((arg) => arg === "-R" || arg === "--repo");
  const inline = args.find((arg) => arg.startsWith("--repo="))?.slice("--repo=".length);
  const slug = repo === -1 ? inline : args[repo + 1];
  const what = `gh ${args
    .filter((arg) => !arg.startsWith("-"))
    .slice(0, 2)
    .join(" ")}`;
  return slug ? { what, step: "pr", dir, slug } : { what, step: "pr", dir };
}

/** The git and gh commands of a bash line that change something, with the directory each runs in (after `cd`). */
export function gitChanges(line: string, cwd: string, home: string): GitChange[] {
  const changes: GitChange[] = [];
  let dir = cwd;
  for (const words of commandsOf(line)) {
    const program = (words[0] as string).replace(/^.*\//, "");
    if (program === "cd") dir = resolveDir(words[1] ?? home, dir, home);
    const change =
      program === "git"
        ? gitChange(words, dir, home)
        : program === "gh"
          ? ghChange(words, dir)
          : program === "jj"
            ? jjChange(words, dir, home)
            : undefined;
    if (change) changes.push(change);
  }
  return changes;
}
