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

## `git_status` and `git_watch`

`git_status` shows all work in progress, across repositories, and reads only: the PRs the watcher
follows (state, fixes, link), what needs the user, and each worktree under `<worktrees>` with its
branch, uncommitted files, unpushed commits, and whether the watcher has its PR. The main agent
uses it instead of listing worktrees and PRs by hand.

`git_watch` hands an open PR that was not made with `git_pr` to the watcher (`pr`: number or URL;
`path`: a directory in the repository). It needs a worktree that has the PR's branch checked out,
because the watcher fixes CI there. After that, the PR is followed like one from `git_pr`.

## The watcher

`watcher.ts` runs one round over the queued PRs; a systemd user timer starts it every minute (see the
[main README](../../README.md)). For each PR it reads the state, the checks and the merge state with
`gh pr view`:

| The PR | The watcher |
|---|---|
| Checks pending | Waits. Checks that wait for an approval count as pending. |
| Checks failed | The helper gets the failing checks with their logs (`gh run view --log-failed` for GitHub Actions) and fixes the files; pi-git commits and pushes the fix with the `git_pr` flow, checks included. When the helper changes nothing (the failure is not caused by the PR), the failed jobs run again once. |
| Conflicts with the base | Rebases the worktree on the base; the helper resolves each conflict; pi-git continues the rebase and force-pushes with a lease on the head it saw. |
| Base moved (a stacked PR whose base was merged and deleted, so GitHub moved the PR to the next base) | Rebases only the PR's own commits (after the last seen tip of the old base) onto the new base, the helper resolving conflicts, and force-pushes with a lease. No report unless it fails. |
| Green and mergeable | Reports it once per head. |
| Merged | Removes the worktree and the local branch (when the worktree is clean), deletes the branch on GitHub when GitHub did not, prunes, reports it, and stops. |
| Closed | Reports it and stops; the worktree and the branch are kept. |

The helper tries each red head once, and at most `attempts` times per PR; then the watcher reports
that the PR needs you.

The watcher survives a reboot: the queue is in files, and the timer starts two minutes after boot
(with lingering, also before you log in). A fix that a reboot breaks off is not counted for its head:
on the next round the watcher aborts its own rebase, stashes the changes of its fix
(`git stash list` shows them as `pi-git: interrupted ... fix of PR #n`), and tries again. Its lock
records the process and the boot, so a lock from before the reboot does not block it. It never merges. It refuses to touch a worktree with uncommitted changes or
with commits that are not on GitHub, and reports that instead.

## Summaries

The watcher writes a summary for each report to `<stateDir>/inbox`. Each pi session sends a heartbeat
and looks for summaries every 20 seconds:

- a summary goes to the session that ran `git_pr`;
- when that session is gone (no heartbeat for 90 seconds), the next session in the same repository
  takes it, so nothing is lost when pi was closed.

Delivered summaries stay in `<stateDir>/delivered` for seven days, then the watcher deletes them.

`delivery` decides how it arrives: `turn` (default) starts a turn of the main agent with it, `message`
adds it to the context for your next prompt, `notify` only shows it to you.

## `git_start`

| Parameter | Meaning |
|---|---|
| `topic` | Short, lower case with hyphens: the worktree directory and the branch name. |
| `type` | `feat` (default), `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore` or `perf`. |
| `base` | The base branch; default: the default branch. For a stacked change, the branch it builds on. |
| `repo` | The repository: a directory in it, `owner/name`, or `name` (found in `~/private`, `~/work`, `~/src`, `~/code` or `~`); default: the working directory. |
| `setup` | Run the setup; default: `true`. |

It fetches, then adds the worktree `<worktrees>/<repo>/<topic>` on `<type>/<topic>` from the fresh
`origin/<base>` (or continues `origin/<type>/<topic>` when that branch exists on GitHub only), and
runs the setup: `devenv shell -- true` with a `devenv.nix`, else `npm ci --ignore-scripts` or
`uv sync`. It returns the path and what to know before the change: the default branch, the commit
style with recent subjects, the check command, a PR template or CONTRIBUTING.md to read, and the
other worktrees of the repository. A failing setup is reported, not fatal. It follows the
`worktree` step of the lock of that repository; `/git worktree <topic> [type]` does it once as your
own action.

## `git_push`

| Parameter | Meaning |
|---|---|
| `path` | A directory in the worktree; default: the working directory. |
| `intent` | What the branch is for; used when the helper has to commit a fix. |

Pushes the commits of the worktree, as `git_pr` does in its second step: the `pre-push` hook runs the
checks, and the helper fixes failures as a new commit. With `commit` locked, the push runs once and
the helper does not fix. Uncommitted changes stay in the worktree.

## `git_commit`

| Parameter | Meaning |
|---|---|
| `intent` | What the change is for and why: the basis of the commit message. |
| `path` | A directory in the worktree; default: the working directory. |

Commits all changes of the worktree, as `git_pr` does in its first step: stage everything, run the
`pre-commit` hook (the helper fixes failures), let the helper write the message, check it with the
`commit-msg` hook, commit. It does not push.

## The lock

By default, agents may not change git repositories. The lock has four steps, each locked on its own:

| Step | Covers |
|---|---|
| `worktree` | Creating and removing worktrees and branches |
| `commit` | `git_commit`, and git commands that change history or files: `commit`, `add`, `reset`, `rebase`, `checkout`, ... |
| `push` | Pushing |
| `pr` | Opening and changing PRs, and other gh commands that change GitHub |

pi-git blocks every git and gh command of the main agent (and of codemode scripts) whose step is
locked, and the tools follow the same steps. `git_pr` runs as far as it may: with only `commit`
unlocked it commits and stops before the push, and says so. Reading stays free: `status`, `diff`,
`log`, `show`, `fetch`, `branch --list`, `gh pr view`, `gh pr checks`, `gh run view`, `gh api` without
a method or fields, and so on.

You switch it in pi; the model cannot:

| Command | Effect |
|---|---|
| `/git` | Shows every step here, where its state comes from, and the overrides |
| `/git unlock [steps]`, `/git lock [steps]` | This repository (owner/name of `origin`); without steps: all of them. Remembered. |
| `/git reset [steps]` | Removes this repository's override, so the global state applies |
| `/git global unlock\|lock\|reset [steps]` | The global state; `reset` goes back to the default of the settings (`locked`) |
| `/git worktree <topic> [type]` | Starts a change once, as `git_start` does |
| `/git commit [intent]` | Commits once, as `git_commit` does |
| `/git push` | Pushes once, as `git_push` does |
| `/git pr [intent]` | Runs `git_pr` once: commit, push and PR, and queues the PR for the watcher |

What decides a step, the first that says something:

1. `/git unlock|lock` for this repository (remembered);
2. `repos` of the settings: patterns such as `my-org/*` or `my-org/infra` with `"locked"`,
   `"unlocked"` or single steps; the most specific pattern that sets the step decides;
3. `/git global unlock|lock`;
4. `locked` of the settings (default `true`).

So a repository in `repos` keeps its setting when you lock or unlock globally, and `/git reset`
brings it back to `repos`. The state is in
`<stateDir>/switch.json`, so every pi session and the watcher see a change at once. The footer shows
`git: locked`, `git: unlocked`, or the unlocked steps (`git: commit unlocked`).

The agent knows the state from the start: before every prompt, a `pi_git` section of the system
prompt lists the allowed and the blocked steps, and says to finish the work and ask you for
`/git unlock <step>` (or `/git <step>` once) instead of working around a lock. The next prompt
carries every change.

The repository of a command is found per command: after `cd`, with `git -C <dir>`, or from
`gh -R owner/name`. Your own commands (`!git ...` in pi, and your terminal) are never blocked. The
watcher fixes CI only with `commit` and `push` unlocked, and cleans up after a merge only with
`worktree` unlocked.

**Hard stop.** pi-git sets `PI_GIT_SWITCH` (the switch file) and `PI_GIT_DEFAULT` in pi's process, so
the agents' commands inherit them, and `PI_GIT_REPOS` (the `repos` settings as JSON). A git hook can read them and refuse a commit (`commit` step) or a
push (`push` step) in a locked repository, also when a script runs git; see the main README. pi-git
runs its own git commands without `PI_GIT_SWITCH`: it checked the lock itself, and `/git commit`
must work while `commit` is locked.

## When the work needs you

pi-git keeps a list of what needs you, in `<stateDir>/attention`:

- a step the agent needed but that is locked (a blocked git command, `git_commit`, `git_pr` that
  stopped before a step);
- a request of the agent with the `git_request` tool: a locked step that a real change needs, or a
  decision only you can make. The agent then stops and waits;
- a PR the watcher cannot finish (the fixes are used up, or a lock holds back a fix).

Each new item is shown in pi and sent as a notification to the terminal of every tmux client
(OSC 777, which WezTerm and other terminals show as a desktop notification; written to the client's
tty, so the watcher can do it too, without passthrough). Repeats do not notify again.

`pi-git-status` prints a red `●` with the number of items, for the tmux status line:

```tmux
set -g status-right '#(pi-git-status)%H:%M'
```

The pi footer shows the count too (`git: locked ● 2`). `/git` lists the items. An unlock of a step,
or `/git <step>` once, answers the items about that step; a PR that turns green or is merged answers
its watcher item; `/git clear` forgets all of them. `PI_GIT_NO_NOTIFY=1` turns the terminal
notifications off.

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
| `locked` | `true` | Whether git changes are locked where neither `/git` nor `repos` says anything |
| `repos` | `{}` | Locks per repository pattern: `{ "my-org/*": "locked", "my-org/app": { "push": "locked" } }` |
| `runtimeDir` | `$XDG_RUNTIME_DIR/pi-git` | Locks and session heartbeats; they must not survive a reboot |
| `stateDir` | `~/.local/state/pi-git` | The queue, the summaries, the attention list and the switch: keep it across reboots (impermanence: persist it) |

| What | Default | Override |
|---|---|---|
| Config file | `~/.pi/agent/pi-git.json` | `PI_GIT_CONFIG` |
| Agent directory | `~/.pi/agent` | `PI_CODING_AGENT_DIR` |

Errors in the config are reported when a session starts; the defaults apply instead.
