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

## `git_check`

| Parameter | Meaning |
|---|---|
| `command` | The check command, run with `sh -c` in the root of the repository. Default: detected. |
| `path` | A directory in the repository; default: the working directory. |
| `fix` | Let the helper fix failures; default: `true`. |

The command is detected in this order: a devenv `check` script (`devenv shell -- check`), the
`check` or `test` script of `package.json`, `nix flake check` when there is a `flake.nix`, and the
`check` or `test` target of a `Makefile`.

While the checks fail, the helper gets the output and fixes the files, up to `attempts` times. The
main agent never reads the output:

- **green:** "Checks passed", the time, and what the helper fixed on the way;
- **red** (after the attempts, or with `fix: false`): an error with the helper's summary of the
  failures (check, file and line, error; at most 15 lines), and what it tried.

`git_check` changes files but never stages or commits them; that stays with `git_pr`.

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

## The lock

By default, agents may not change git repositories. pi-git blocks every git and gh command of the
main agent (and of codemode scripts) that changes something, and `git_pr` and the watcher refuse
too. Reading stays free: `status`, `diff`, `log`, `show`, `fetch`, `branch --list`, `gh pr view`,
`gh pr checks`, `gh run view`, `gh api` without a method or fields, and so on. Everything else counts
as a change: `commit`, `push`, `add`, `checkout`, `rebase`, `branch <name>`, `worktree add`,
`gh pr create`, `gh pr merge`, ...

You switch it in pi; the model cannot:

| Command | Effect |
|---|---|
| `/git` | Shows the state here, the global state and the overrides |
| `/git unlock`, `/git lock` | This repository (owner/name of `origin`); remembered |
| `/git reset` | Removes the override of this repository: the global state applies |
| `/git global unlock`, `/git global lock`, `/git global reset` | The global state; `reset` goes back to the default of the settings (`locked`) |

The agent knows the state from the start: before every prompt, a `pi_git` section of the system
prompt says `git: locked in owner/name` (what is blocked, what is allowed, and to finish the work and
ask you for `/git unlock` instead of working around it) or `git: unlocked in owner/name` (use
`git_pr`). After `/git unlock`, the next prompt carries the new state.

A repository's override wins over the global state, which wins over the default. The state is in
`<stateDir>/switch.json`, so every pi session and the watcher see a change at once. The footer shows
`git: locked` or `git: unlocked` for the repository of the session.

The repository of a command is found per command: after `cd`, with `git -C <dir>`, or from
`gh -R owner/name`. Your own commands (`!git ...` in pi, and your terminal) are never blocked.

**Hard stop.** pi-git sets `PI_GIT_SWITCH` (the switch file) and `PI_GIT_DEFAULT` in pi's process, so
the agents' commands inherit them. A git hook can read them and refuse commits and pushes in a
locked repository, also when a script runs git; see the main README.

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
| `locked` | `true` | Whether git changes are locked where `/git` says nothing |
| `stateDir` | `~/.local/state/pi-git` | The queue, the summaries and the heartbeats |

| What | Default | Override |
|---|---|---|
| Config file | `~/.pi/agent/pi-git.json` | `PI_GIT_CONFIG` |
| Agent directory | `~/.pi/agent` | `PI_CODING_AGENT_DIR` |

Errors in the config are reported when a session starts; the defaults apply instead.
