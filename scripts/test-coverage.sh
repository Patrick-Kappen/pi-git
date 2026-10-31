#!/usr/bin/env bash
set -euo pipefail

coverage_dir="$(mktemp -d "${TMPDIR:-/tmp}/pi-git-coverage.XXXXXXXXXX")"
trap 'rm -rf "$coverage_dir"' EXIT

vitest run --coverage --coverage.reportsDirectory="$coverage_dir"
