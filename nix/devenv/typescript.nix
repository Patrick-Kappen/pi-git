# TypeScript: Node 24 with npm, TypeScript and Vitest from package.json, Biome from nixpkgs.
{
  pkgs,
  repoHookScript,
  ...
}:
let
  node = pkgs.nodejs_24;
  nodeTools = [
    node
    pkgs.git
    pkgs.coreutils
  ];
  npmCi = "[ -d node_modules ] || npm ci --ignore-scripts --no-audit --no-fund";
in
{
  languages.javascript = {
    enable = true;
    package = node;
    npm = {
      enable = true;
      install.enable = true;
    };
  };
  languages.typescript.enable = true;

  # Biome from nixpkgs: npm's prebuilt binary does not run on NixOS.
  repo.tools = [
    pkgs.biome
    node
  ];

  scripts = {
    lint-language.exec = "biome ci .";
    typecheck.exec = "tsc";
    unit.exec = ''
      if [ "$#" -gt 0 ]; then
        exec vitest related --run --passWithNoTests "$@"
      fi
      exec vitest run
    '';
    test-all.exec = ''
      set -euo pipefail
      knip
      vitest run --coverage
    '';
    security-language.exec = "npm audit --audit-level=moderate";
  };

  git-hooks.hooks = {
    biome = {
      enable = true;
      settings = {
        write = false;
        flags = "--no-errors-on-unmatched";
      };
    };
    typecheck = {
      enable = true;
      name = "tsc";
      entry = "${repoHookScript "typecheck" nodeTools ''
        ${npmCi}
        exec node_modules/.bin/tsc
      ''}";
      files = "\\.ts$|^tsconfig\\.json$|^package(-lock)?\\.json$";
      pass_filenames = false;
    };
    tests-changed = {
      enable = true;
      name = "vitest: tests of the staged files";
      entry = "${repoHookScript "tests-changed" nodeTools ''
        ${npmCi}
        exec node_modules/.bin/vitest related --run --passWithNoTests "$@"
      ''}";
      files = "\\.ts$";
      pass_filenames = true;
      require_serial = true;
    };
  };
}
