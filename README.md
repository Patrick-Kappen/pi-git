# pi-git

pi extension that commits, pushes and opens PRs with a helper agent, watches CI until the PR is
green, and runs checks without flooding the main agent.

The main agent of pi is good at making a change and expensive at the rest: running the hooks, reading
their output, fixing lint, writing the commit message and the PR. With pi-git, the main agent calls
`git_pr` with what the change is for. A cheap helper agent (`pi -p` with another model) fixes failing
checks and writes the commit message and the PR; pi-git runs every git and GitHub step itself.
`git_status` shows all open work across repositories, and `git_watch` hands a PR made by hand to the
watcher. `git_check` runs the checks of a repository the same way: the helper fixes failures, and the main
agent gets "passed" or a short summary instead of the full output. A
watcher (a systemd user timer) then follows the PR: the helper fixes red CI and conflicts, and the
main agent gets a summary when the PR is green, merged, or needs you. See the
[extension README](extensions/pi-git/README.md).

Agents may not change git repositories until you allow it, per step (`worktree`, `commit`, `push`,
`pr`): `/git unlock commit` in pi unlocks committing in the current repository and remembers it,
`/git unlock` unlocks every step, `/git global unlock` works everywhere, and `/git commit` commits once
as your own action. See
[the lock](extensions/pi-git/README.md#the-lock).

When the work needs you (a locked step, a request of the agent with `git_request`, a PR the watcher
cannot finish), pi-git sends a notification to your terminals (WezTerm shows it) and `pi-git-status`
puts a red `●` in the tmux status line. See
[when the work needs you](extensions/pi-git/README.md#when-the-work-needs-you).

It works with the `git` skill of [pi-skills](https://github.com/Patrick-Kappen/pi-skills), which
both agents follow: always a worktree in `~/.worktrees/<repo>/<topic>`, never on the default branch.

## Use with Home Manager

```nix
{
  inputs.pi-git = {
    url = "github:Patrick-Kappen/pi-git/latest"; # the latest release
    inputs.nixpkgs.follows = "nixpkgs";
    inputs.home-manager.follows = "home-manager";
  };
}
```

```nix
{ config, inputs, ... }:
{
  imports = [ inputs.pi-git.homeModules.default ];

  programs.pi-git = {
    enable = true;
    model = "openai-codex/gpt-6-luna";
    thinking = "xhigh";
    skill = "${config.programs.pi-skills.skillsPackage}/git";
  };
}
```

| Option | Default | Meaning |
|---|---|---|
| `model`, `thinking` | `openai-codex/gpt-6-luna`, `xhigh` | The helper's model and thinking level |
| `skill` | `null` | The git skill directory |
| `attempts` | `3` | Fix attempts per failing step |
| `checkTimeout`, `helperTimeout` | `1800`, `900` | Seconds for one hook run and one helper run |
| `pi` | `"pi"` | The pi command for the helper |
| `delivery` | `"turn"` | How the watcher's summary reaches the main agent: `turn`, `message` or `notify` |
| `locked` | `true` | Git changes by agents are locked until you run `/git unlock [worktree commit push pr]` in a repository (remembered); `false` unlocks by default |
| `repos` | `{ }` | Locks per repository pattern, e.g. `{ "my-org/infra" = "locked"; "my-org/*".push = "locked"; }`; they win over `/git global` and `locked` |
| `watcher.enable` | `true` | The systemd user timer `pi-git-watcher` |
| `watcher.interval` | `"1min"` | How often the watcher runs |
| `watcher.environment` | `{ }` | Extra environment, for example `SSH_AUTH_SOCK = "%t/ssh-agent";` for `git push` |
| `watcher.packages` | `[ ]` | Extra tools on the watcher's PATH, for the hooks of your repositories |
| `statusPackage` | `packages.<system>.pi-git-status` | Installed in your profile: `#(pi-git-status)` in the tmux status line shows a red `●` with what needs you |
| `package`, `agentDir` | this flake, `.pi/agent` | The extension, and pi's agent directory |

## A hard stop in git hooks

pi-git blocks the agents' git commands before they run. To also stop git itself, for example when a
script of the agent runs `git commit`, a global hook can check the lock. The agents' processes have
`PI_GIT_SWITCH`, `PI_GIT_DEFAULT` and `PI_GIT_REPOS`; your terminal does not, so you are never
blocked. This function follows the same order as pi-git; call it as `pi_git_lock pre-commit commit`
in pre-commit and `pi_git_lock pre-push push` in pre-push (it needs `jq` and `sed`):

```sh
pi_git_lock() {
  [[ -n ${PI_GIT_SWITCH:-} ]] || return 0
  local name="$1" step="$2" url slug switch repos state
  url="$(git remote get-url origin 2>/dev/null || true)"
  slug="$(sed -E 's#\.git$##; s#/+$##; s#.*[:/]([^/:]+/[^/]+)$#\1#' <<<"${url}")"
  switch="$(cat "${PI_GIT_SWITCH}" 2>/dev/null || echo '{}')"
  repos="${PI_GIT_REPOS:-}"
  [[ -n ${repos} ]] || repos='{}'
  state="$(jq -n -r --arg slug "${slug,,}" --arg step "${step}" --arg fallback "${PI_GIT_DEFAULT:-locked}" \
    --argjson switch "${switch}" --argjson repos "${repos}" '
    def pick: if type == "string" then . elif type == "object" then .[$step] else null end;
    def rx: ascii_downcase | gsub("(?<c>[.+?^${}()|\\[\\]\\\\])"; "\\\(.c)") | gsub("\\*"; "[^/]*") | "(^|/)" + . + "$";
    def stars: [scan("\\*")] | length;
    (($switch.repos // {}) | to_entries | map(select(.key | ascii_downcase == $slug)) | first | .value | pick)
      // ($repos | to_entries | map(select(.key as $k | $slug | test($k | rx))) | map(select(.value | pick != null))
           | sort_by([(.key | stars), -(.key | length)]) | first | .value | pick)
      // ($switch.global | pick) // $fallback' 2>/dev/null || true)"
  [[ -n ${state} ]] || state="${PI_GIT_DEFAULT:-locked}"
  if [[ ${state} != unlocked ]]; then
    echo "${name}: ${step} by pi agents is locked in ${slug:-this repository}; unlock with /git unlock ${step} in pi" >&2
    exit 1
  fi
}
```

## Layout

| Path | Contains |
|---|---|
| `extensions/pi-git/` | The extension, with unit tests; `pr.test.ts` runs the whole flow with real git and a fake helper |
| `test/integration/` | Runs the extension in pi's own session with a scripted model: the lock in the prompt, a blocked commit, `/git unlock` |
| `nix/package.nix` | The package `pi-git` |
| `nix/home-manager.nix` | The Home Manager module |
| `nix/checks.nix`, `test/nix/` | Flake checks: the package, the module, and the generated config with node |

## Development

The dev environment uses [devenv](https://devenv.sh):

```sh
devenv shell   # tools, dependencies and git hooks
check          # everything CI runs
```

| Command | What it runs |
|---|---|
| `lint` | Linters and formatters (check only) |
| `typecheck` | The type checker |
| `unit [files]` | Unit tests; with files, only the tests related to them |
| `security` | gitleaks over the history, and known vulnerabilities in the lock files |
| `check` | All of the above with coverage, plus `nix flake check` if there is a `flake.nix` |

### Git hooks

| Hook | Checks |
|---|---|
| `pre-commit` | The staged files: linters, types, and the unit tests related to them; secrets; no commits on `main` |
| `commit-msg` | [Conventional Commits](https://www.conventionalcommits.org/) |
| `pre-push` | `check` |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## CI and releases

- `ci.yml` runs `devenv test` on every PR and on `main`, and checks the PR title and commit messages.
- `release.yml` runs [release-please](https://github.com/googleapis/release-please) on `main`:
  1. It keeps one release PR that collects the merged PRs, with the version bump and the notes in
     [`CHANGELOG.md`](CHANGELOG.md).
  2. Merging that PR tags `vX.Y.Z`, publishes the release, and moves the `latest` branch to it.
- Squash-merge PRs: the PR title becomes the commit on `main`.
