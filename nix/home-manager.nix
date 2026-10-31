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
  json = pkgs.formats.json { };
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
  };

  config = lib.mkIf cfg.enable {
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
            ;
        }
        // lib.optionalAttrs (cfg.skill != null) { skill = "${cfg.skill}"; }
      );
    };
  };
}
