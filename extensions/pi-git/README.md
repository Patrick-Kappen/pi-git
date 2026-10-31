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

After the PR is open, `git_pr` queues it for the watcher.

## The watcher

`watcher.ts` runs one round over the queued PRs; a systemd user timer starts it every minute (see the
[main README](../../README.md)). For each PR it reads the state, the checks and the merge state with
`gh pr view`:

| The PR | The watcher |
|---|---|
| Checks pending | Waits. Checks that wait for an approval count as pending. |
| Checks failed | The helper gets the failing checks with their logs (`gh run view --log-failed` for GitHub Actions) and fixes the files; pi-git commits and pushes the fix with the `git_pr` flow, checks included. When the helper changes nothing (the failure is not caused by the PR), the failed jobs run again once. |
| Conflicts with the base | Rebases the worktree on the base; the helper resolves each conflict; pi-git continues the rebase and force-pushes with a lease on the head it saw. |
| Green and mergeable | Reports it once per head. |
| Merged | Removes the worktree and the local branch (when the worktree is clean), prunes, reports it, and stops. |
| Closed | Reports it and stops; the worktree and the branch are kept. |

The helper tries each red head once, and at most `attempts` times per PR; then the watcher reports
that the PR needs you. It never merges. It refuses to touch a worktree with uncommitted changes or
with commits that are not on GitHub, and reports that instead.

## Summaries

The watcher writes a summary for each report to `<stateDir>/inbox`. Each pi session sends a heartbeat
and looks for summaries every 20 seconds:

- a summary goes to the session that ran `git_pr`;
- when that session is gone (no heartbeat for 90 seconds), the next session in the same repository
  takes it, so nothing is lost when pi was closed.

`delivery` decides how it arrives: `turn` (default) starts a turn of the main agent with it, `message`
adds it to the context for your next prompt, `notify` only shows it to you.

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
| `delivery` | `turn` | How a summary reaches the main agent: `turn`, `message` or `notify` |
| `stateDir` | `~/.local/state/pi-git` | The queue, the summaries and the heartbeats |

| What | Default | Override |
|---|---|---|
| Config file | `~/.pi/agent/pi-git.json` | `PI_GIT_CONFIG` |
| Agent directory | `~/.pi/agent` | `PI_CODING_AGENT_DIR` |

Errors in the config are reported when a session starts; the defaults apply instead.
