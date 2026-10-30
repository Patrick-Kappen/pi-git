# Security

Report vulnerabilities privately through GitHub's "Report a vulnerability" on this repository.

What this repository checks:

- Secrets: gitleaks on every commit and over the whole history.
- Dependencies: osv-scanner over the lock files, and weekly Dependabot updates.
- GitHub Actions: actionlint and zizmor. Actions are pinned to commit SHAs, and workflow permissions
  are empty by default.
