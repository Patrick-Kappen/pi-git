# Home Manager module: installs the pi-git extension and writes its settings.
{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cfg = config.programs.pi-git;
  steps = [
    "worktree"
    "commit"
    "push"
    "pr"
  ];
  stepOption =
    step:
    lib.mkOption {
      type = lib.types.nullOr (
        lib.types.enum [
          "locked"
          "unlocked"
        ]
      );
      default = null;
      description = "The lock of ${step}; null follows the next level.";
    };
  json = pkgs.formats.json { };
  configFile = "${config.home.homeDirectory}/${cfg.agentDir}/pi-git.json";
  watcherPath = lib.concatStringsSep ":" [
    (lib.makeBinPath (
      [
        pkgs.git
        pkgs.jujutsu
        pkgs.gh
        pkgs.nodejs_24
        pkgs.openssh
        pkgs.coreutils
        pkgs.bash
      ]
      ++ cfg.watcher.packages
    ))
    "${config.home.profileDirectory}/bin"
    "/etc/profiles/per-user/${config.home.username}/bin"
    "/run/current-system/sw/bin"
    "/run/wrappers/bin"
  ];
in
{
  options.programs.pi-git = {
    enable = lib.mkEnableOption "the pi-git extension: git_pr commits, pushes and opens PRs with a helper agent";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-git;
      defaultText = lib.literalExpression "pi-git.packages.\${system}.pi-git";
      description = "The pi-git extension package.";
    };

    statusPackage = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.pi-git-status;
      defaultText = lib.literalExpression "pi-git.packages.\${system}.pi-git-status";
      description = ''
        pi-git-status, installed in your profile: a red mark with the number of things that need
        you, for the tmux status line: `set -g status-right '#(pi-git-status)...'`.
      '';
    };

    agentDir = lib.mkOption {
      type = lib.types.str;
      default = ".pi/agent";
      description = "pi's agent directory relative to the home directory. Change it together with `PI_CODING_AGENT_DIR`.";
    };

    model = lib.mkOption {
      type = lib.types.str;
      default = "openai-codex/gpt-6-luna";
      example = "anthropic/claude-haiku-4-5";
      description = "The helper's model, as `pi --model` takes it.";
    };

    thinking = lib.mkOption {
      type = lib.types.enum [
        "off"
        "minimal"
        "low"
        "medium"
        "high"
        "xhigh"
        "max"
      ];
      default = "xhigh";
      description = "The helper's thinking level.";
    };

    skill = lib.mkOption {
      type = lib.types.nullOr (lib.types.either lib.types.path lib.types.str);
      default = null;
      example = lib.literalExpression ''"${config.programs.pi-skills.skillsPackage}/git"'';
      description = "The git skill directory (with SKILL.md); the helper loads it with `/skill:git`.";
    };

    pi = lib.mkOption {
      type = lib.types.str;
      default = "pi";
      description = "The pi command the helper runs.";
    };

    attempts = lib.mkOption {
      type = lib.types.ints.positive;
      default = 3;
      description = "How often the helper may try to fix one failing step.";
    };

    checkTimeout = lib.mkOption {
      type = lib.types.ints.positive;
      default = 1800;
      description = "Seconds for one hook run; the pre-push hook runs all checks.";
    };

    helperTimeout = lib.mkOption {
      type = lib.types.ints.positive;
      default = 900;
      description = "Seconds for one helper run.";
    };

    locked = lib.mkOption {
      type = lib.types.bool;
      default = true;
      description = ''
        Whether git changes by agents are locked where neither /git nor `repos` says anything. The
        lock has four steps: worktree, commit, push and pr. Unlock steps of one repository with /git unlock [steps] in pi;
        that is remembered. /git global unlock [steps] changes the global state, and /git commit
        commits once.
      '';
    };

    repos = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.either (lib.types.enum [
          "locked"
          "unlocked"
        ]) (lib.types.submodule { options = lib.genAttrs steps stepOption; })
      );
      default = { };
      example = lib.literalExpression ''
        {
          "my-org/infra" = "locked";                 # every step
          "my-org/*" = { push = "locked"; pr = "locked"; };
          "my-org/sandbox" = "unlocked";
        }
      '';
      description = ''
        Locks per repository: a pattern (owner/name; `*` matches within a part) and `"locked"`,
        `"unlocked"`, or the steps (worktree, commit, push, pr). The most specific pattern that sets a
        step decides. /git for one repository wins over these settings; they win over /git global and
        over `locked`.
      '';
    };

    backend = lib.mkOption {
      type = lib.types.enum [
        "git"
        "jj"
      ];
      default = "git";
      description = ''
        How git_start makes new worktrees: `git` worktrees, or colocated `jj` workspaces, where every
        agent turn is a work-in-progress commit and git_commit splits the work into logical commits.
        In a repository without jj, pi-git runs `jj git init --colocate` first. Worktrees that exist
        keep their kind. /git backend git|jj|reset sets one repository in pi.
      '';
    };

    backends = lib.mkOption {
      type = lib.types.attrsOf (
        lib.types.enum [
          "git"
          "jj"
        ]
      );
      default = { };
      example = {
        "my-org/sandbox" = "jj";
      };
      description = ''
        Backends per repository pattern, matched as in `repos`. /git backend for one repository wins
        over these settings; they win over `backend`.
      '';
    };

    delivery = lib.mkOption {
      type = lib.types.enum [
        "turn"
        "message"
        "notify"
      ];
      default = "turn";
      description = ''
        How a summary of the watcher reaches the main agent: `turn` starts a turn with it, `message`
        adds it to the context for your next prompt, `notify` only shows it to you.
      '';
    };

    ship = {
      nixos = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "~/nixos-config";
        description = "The main checkout of the NixOS configuration that /ship locks the releases in.";
      };
      host = lib.mkOption {
        type = lib.types.nullOr lib.types.str;
        default = null;
        example = "gaia";
        description = "The host whose deploy check (deploy-<host>) confirms a ship; default: this machine's host name.";
      };
      model = lib.mkOption {
        type = lib.types.str;
        default = "openai-codex/gpt-6-luna";
        description = "The model of the agent that decides /ship's releases for changes without feat or fix.";
      };
      repos = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ "*/pi-*" ];
        example = [ "my-org/*" ];
        description = "The repositories /ship ships, as owner/name globs; others are left alone.";
      };
      thinking = lib.mkOption {
        type = lib.types.str;
        default = "medium";
        description = "The thinking level of that agent.";
      };
    };

    watcher = {
      enable = lib.mkOption {
        type = lib.types.bool;
        default = true;
        description = "Run the watcher, a systemd user timer that follows the PRs of git_pr.";
      };

      interval = lib.mkOption {
        type = lib.types.str;
        default = "1min";
        description = "How often the watcher runs (a systemd time span).";
      };

      packages = lib.mkOption {
        type = lib.types.listOf lib.types.package;
        default = [ ];
        description = "Extra tools on the watcher's PATH, for the hooks of your repositories.";
      };

      environment = lib.mkOption {
        type = lib.types.attrsOf lib.types.str;
        default = { };
        example = {
          SSH_AUTH_SOCK = "%t/ssh-agent";
        };
        description = "Extra environment of the watcher, for example the SSH agent for git push.";
      };
    };
  };

  config = lib.mkIf cfg.enable {
    home.packages = [ cfg.statusPackage ];

    systemd.user = lib.mkIf cfg.watcher.enable {
      services.pi-git-watcher = {
        Unit.Description = "pi-git watcher: follows the PRs of git_pr";
        Service = {
          Type = "oneshot";
          ExecStart = "${pkgs.nodejs_24}/bin/node ${cfg.package}/watcher.ts";
          Environment = lib.mapAttrsToList (name: value: "${name}=${value}") (
            {
              PATH = watcherPath;
              PI_GIT_CONFIG = configFile;
            }
            // cfg.watcher.environment
          );
        };
      };
      timers.pi-git-watcher = {
        Unit.Description = "Run the pi-git watcher";
        Timer = {
          OnBootSec = "2min";
          OnUnitInactiveSec = cfg.watcher.interval;
        };
        Install.WantedBy = [ "timers.target" ];
      };
    };

    home.file = {
      "${cfg.agentDir}/extensions/pi-git".source = cfg.package;
      "${cfg.agentDir}/pi-git.json".source = json.generate "pi-git.json" (
        {
          inherit (cfg)
            model
            thinking
            pi
            attempts
            checkTimeout
            helperTimeout
            delivery
            locked
            backend
            backends
            ;
          repos = lib.mapAttrs (
            _: setting:
            if builtins.isString setting then setting else lib.filterAttrs (_: lock: lock != null) setting
          ) cfg.repos;
        }
        // lib.optionalAttrs (cfg.skill != null) { skill = "${cfg.skill}"; }
        // lib.optionalAttrs (cfg.ship.nixos != null) { shipNixos = cfg.ship.nixos; }
        // lib.optionalAttrs (cfg.ship.host != null) { shipHost = cfg.ship.host; }
        // {
          shipModel = cfg.ship.model;
          shipThinking = cfg.ship.thinking;
          shipRepos = cfg.ship.repos;
        }
      );
    };
  };
}
