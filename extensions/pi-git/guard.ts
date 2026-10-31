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
    if (program === "gh") return "gh";
  }
  return undefined;
}
