# pi-git

A pi extension that takes the git work off the main agent. The main agent makes the change in a
worktree and calls `git_pr`; pi-git commits, pushes and opens the PR. A cheap helper agent fixes
failing checks and writes the commit message and the PR. The main agent only sees the result.

## `git_pr`

| Parameter | Meaning |
|---|---|
| `intent` | What the change is for and why: the basis of the commit message and the PR. |
| `path` | A directory in the worktree; default: the working directory. |
| `base` | The base branch; default: that of the open PR, else the default branch. |
| `draft` | Open the PR as a draft. |

What it does, in the worktree of `path`:

1. **Checks where it is.** It refuses the main checkout, a detached HEAD and the default branch: work
   goes in a worktree on a `<type>/<topic>` branch (see the git skill).
2. **Stages everything** and runs the repository's `pre-commit` hook (`git hook run`, so global
   hooks count too). While it fails, the helper gets the output and fixes the files, up to
   `attempts` times.
3. **Commit message:** the helper gets the intent, the staged diff and the recent subjects of the
   base branch, and answers with JSON. The `commit-msg` hook checks it before the commit; a
   rejected message goes back to the helper.
4. **Commits and pushes.** The `pre-push` hook runs the checks; while they fail, the helper fixes
   them. Its fix is amended into a commit that is not on GitHub yet, else it becomes a new commit.
   When the branch on GitHub has commits the worktree lacks, pi-git rebases on them first.
5. **PR:** the helper writes the title and body (JSON) from the intent, the commits, the diff and the
   repository's PR template. pi-git opens the PR with `gh pr create`, or updates the open PR of the
   branch with `gh pr edit`.

When a step still fails, `git_pr` stops with an error: the output, what the helper tried, and what
state the worktree is in (staged, or pushed). Progress shows in the tool call while it runs.

## The helper

The helper is `pi -p` with its own model, started in the worktree:

- answers (commit message, PR) run with `--no-extensions` and only the `read` tool, so it can read
  the references of the git skill;
- fixes run with the file tools and bash, and with your extensions, so pi-rules permissions and
  hooks apply. pi-git sees `PI_GIT_HELPER` and blocks git commands that change the repository
  (`commit`, `push`, `rebase`, `reset`, `add`, ...) and `gh`: pi-git does those itself;
- every prompt starts with `/skill:git` when `skill` is set, so the helper follows the git skill.

## Configuration

`~/.pi/agent/pi-git.json` (Home Manager writes this file; see the [main README](../../README.md)):

| Key | Default | Meaning |
|---|---|---|
| `model` | `openai-codex/gpt-6-luna` | The helper's model |
| `thinking` | `xhigh` | The helper's thinking level |
| `skill` | none | The git skill directory, loaded with `/skill:git` |
| `pi` | `pi` | The pi command for the helper |
| `attempts` | `3` | Fix attempts per failing step |
| `checkTimeout` | `1800` | Seconds for one hook run |
| `helperTimeout` | `900` | Seconds for one helper run |

| What | Default | Override |
|---|---|---|
| Config file | `~/.pi/agent/pi-git.json` | `PI_GIT_CONFIG` |
| Agent directory | `~/.pi/agent` | `PI_CODING_AGENT_DIR` |

Errors in the config are reported when a session starts; the defaults apply instead.
