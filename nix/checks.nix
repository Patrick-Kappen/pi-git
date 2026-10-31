{
  self,
  pkgs,
  home-manager,
}:
let
  packages = self.packages.${pkgs.stdenv.hostPlatform.system};
  hm = home-manager.lib.homeManagerConfiguration {
    inherit pkgs;
    modules = [
      self.homeModules.default
      {
        home = {
          username = "check";
          homeDirectory = "/home/check";
          stateVersion = "25.11";
        };
        programs.pi-git = {
          enable = true;
          model = "anthropic/claude-haiku-4-5";
          skill = ../test/nix/git-skill;
        };
      }
    ];
  };
in
{
  inherit (packages) pi-git;

  # Builds a Home Manager configuration with the module and reads the generated files with node.
  home-manager =
    pkgs.runCommand "home-manager-check"
      {
        nativeBuildInputs = [
          pkgs.nodejs_24
          pkgs.jq
        ];
        homeFiles = hm.config.home-files;
        smoke = ../test/nix/home-manager-smoke.ts;
      }
      ''
        export HOME=$TMPDIR
        agent=.pi/agent
        test -f "$homeFiles/$agent/extensions/pi-git/index.ts"
        test ! -e "$homeFiles/$agent/extensions/pi-git/index.test.ts"
        jq -e '.model == "anthropic/claude-haiku-4-5" and .thinking == "xhigh" and .attempts == 3' "$homeFiles/$agent/pi-git.json"
        test -f "$(jq -r .skill "$homeFiles/$agent/pi-git.json")/SKILL.md"
        cp "$smoke" smoke.ts
        node smoke.ts "$homeFiles" "$agent"
        touch $out
      '';
}
