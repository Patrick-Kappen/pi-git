# The dev environment. The language part is in nix/devenv/typescript.nix; it defines the scripts
# typecheck, unit, test-all, lint-language and security-language that the common scripts call.
{
  pkgs,
  lib,
  config,
  ...
}:
let
  commonTools = [
    pkgs.gitleaks
    pkgs.osv-scanner
    pkgs.actionlint
    pkgs.zizmor
    pkgs.typos
    pkgs.markdownlint-cli2
    pkgs.convco
    pkgs.nixfmt
    pkgs.statix
    pkgs.deadnix
    pkgs.shellcheck
    pkgs.jq
    pkgs.gh
    pkgs.git
    pkgs.jujutsu
    pkgs.coreutils
  ];
  # Hooks also run outside `devenv shell`, so each brings its own PATH. git sets GIT_INDEX_FILE and
  # more for hooks; tests that create temp repositories must not see them.
  hookScript =
    name: inputs: text:
    pkgs.writeShellScript name ''
      set -euo pipefail
      unset "''${!GIT_@}"
      export PATH=${lib.makeBinPath inputs}:$PATH
      ${text}
    '';
  scriptPackages = map (name: config.scripts.${name}.scriptPackage) [
    "lint"
    "lint-language"
    "typecheck"
    "unit"
    "test-all"
    "security"
    "security-language"
  ];
in
{
  imports = [ ./nix/devenv/typescript.nix ];

  options.repo.tools = lib.mkOption {
    type = lib.types.listOf lib.types.package;
    default = [ ];
    description = "Tools of the language module; on PATH in the shell and in the pre-push hook.";
  };

  config = {
    name = "pi-git";

    packages = commonTools ++ config.repo.tools;

    scripts = {
      lint.description = "All linters and formatters, check only";
      lint.exec = ''
        set -euo pipefail
        lint-language
        typos
        markdownlint-cli2 "**/*.md"
        nixfmt --check $(git ls-files '*.nix')
        statix check .
        deadnix --fail .
        if [ -d .github/workflows ]; then
          actionlint
          zizmor --offline --min-severity=low .github/workflows
        fi
        shellcheck .githooks/* $(git ls-files '*.sh')
      '';

      security.description = "Secrets in the git history and known vulnerabilities in the lock files";
      security.exec = ''
        set -euo pipefail
        gitleaks git --redact --no-banner .
        # 128: no lock files found, which is fine for a repository without dependencies.
        osv-scanner scan source --recursive . || [ $? -eq 128 ]
        security-language
      '';

      check.description = "Everything the pre-push hook and CI run";
      check.exec = ''
        set -euo pipefail
        lint
        typecheck
        test-all
        security
        if [ ! -f flake.nix ] || [ "''${SKIP_FLAKE_CHECK:-0}" = 1 ]; then
          echo "check: nix flake check skipped"
        else
          nix flake check --print-build-logs
        fi
      '';

      # .githooks/* call this: it runs the hooks below with prek, from the config devenv built.
      git-hook.description = "Run the git hooks of devenv.nix for one hook type (called by .githooks/)";
      git-hook.exec = ''
        set -euo pipefail
        hook="$1"
        shift
        top="$(git rev-parse --show-toplevel)"
        exec ${lib.getExe config.git-hooks.package} hook-impl \
          --config ${config.git-hooks.configFile} \
          --hook-type "$hook" --hook-dir "$top/.githooks" -- "$@"
      '';
    };

    # devenv would install prek into the hooks directory, which fails (or bypasses them) when global
    # hooks are configured with core.hooksPath. .githooks/ is tracked instead: global hooks call it,
    # and without global hooks this points core.hooksPath at it.
    tasks."devenv:git-hooks:install".exec = lib.mkForce ''
      if ! git config --get core.hooksPath >/dev/null; then
        git config --local core.hooksPath .githooks
      fi
    '';

    git-hooks = {
      excludes = [
        "\\.lock$"
        "^package-lock\\.json$"
        "^CHANGELOG\\.md$"
      ];
      hooks = {
        check-added-large-files.enable = true;
        check-merge-conflicts.enable = true;
        check-case-conflicts.enable = true;
        check-json.enable = true;
        check-yaml.enable = true;
        end-of-file-fixer.enable = true;
        trim-trailing-whitespace.enable = true;
        no-commit-to-branch = {
          enable = true;
          settings.branch = [ "main" ];
        };

        detect-private-keys.enable = true;
        gitleaks.enable = true;
        zizmor = {
          enable = true;
          args = [
            "--offline"
            "--min-severity=low"
          ];
        };

        typos.enable = true;
        markdownlint-cli2 = {
          enable = true;
          name = "markdownlint-cli2";
          entry = lib.getExe pkgs.markdownlint-cli2;
          files = "\\.md$";
        };
        actionlint.enable = true;
        shellcheck.enable = true;
        nixfmt.enable = true;
        statix.enable = true;
        deadnix = {
          enable = true;
          settings.noLambdaPatternNames = false;
        };

        # Commit messages: Conventional Commits, which release-please turns into release notes.
        convco.enable = true;

        # Pre-push: everything, like CI.
        check-all = {
          enable = true;
          name = "check: lint, types, tests with coverage, security, nix flake check";
          entry = "${hookScript "check-all" (commonTools ++ config.repo.tools ++ scriptPackages) ''
            # Tools installed by the language's package manager.
            export PATH="$PWD/node_modules/.bin:$PWD/.devenv/state/venv/bin:$PATH"
            # The owner's global pre-push hook already runs nix flake check (zd.flakeCheck).
            if [ "$(git config --bool --get zd.flakeCheck || true)" = true ]; then
              export SKIP_FLAKE_CHECK=1
            fi
            exec ${config.scripts.check.scriptPackage}/bin/check
          ''}";
          stages = [ "pre-push" ];
          pass_filenames = false;
          always_run = true;
          require_serial = true;
        };
      };
    };

    _module.args.repoHookScript = hookScript;

    enterShell = ''
      echo "pi-git: 'check' runs everything; 'devenv info' lists the scripts"
    '';

    enterTest = ''
      check
    '';
  };
}
