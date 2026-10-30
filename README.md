# pi-git

pi extension that commits, pushes and opens PRs with a helper agent, and watches CI until the PR is green

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
