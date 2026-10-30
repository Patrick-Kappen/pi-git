# Contributing

1. Run `devenv shell` once; it installs the dependencies and builds the git hooks.
2. Work on a branch (`<type>/<topic>`); commits on `main` are refused.
3. Write [Conventional Commits](https://www.conventionalcommits.org/), for example
   `feat(parser): accept empty input`. The pre-commit hook runs the tests related to your changes.
4. Push: the pre-push hook runs `check`, the same checks as CI.
5. Open a PR with a Conventional Commit title. After CI passes and the review is done, it is
   squash-merged.

Releases are made by merging the release PR; see the README.
