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
          delivery = "message";
          watcher.environment.SSH_AUTH_SOCK = "%t/ssh-agent";
          repos = {
            "my-org/*" = "locked";
            "my-org/sandbox".commit = "unlocked";
          };
        };
      }
    ];
  };
in
{
  inherit (packages) pi-git pi-git-status;

  # pi-git-status prints nothing without items, and a red mark with the count with items.
  status =
    pkgs.runCommand "pi-git-status-check" { nativeBuildInputs = [ packages.pi-git-status ]; }
      ''
        export PI_GIT_STATE_DIR=$TMPDIR/state
        test -z "$(pi-git-status)"
        mkdir -p $PI_GIT_STATE_DIR/attention
        echo '{}' > $PI_GIT_STATE_DIR/attention/a.json
        echo '{}' > $PI_GIT_STATE_DIR/attention/b.json
        test "$(pi-git-status)" = '#[fg=red]● 2#[default] '
        touch $out
      '';

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
        jq -e '.model == "anthropic/claude-haiku-4-5" and .thinking == "xhigh" and .attempts == 3 and .delivery == "message" and .locked == true and .repos == { "my-org/*": "locked", "my-org/sandbox": { commit: "unlocked" } }' "$homeFiles/$agent/pi-git.json"
        unit="$homeFiles/.config/systemd/user/pi-git-watcher.service"
        grep -q "ExecStart=.*/bin/node .*/watcher.ts" "$unit"
        grep -q "SSH_AUTH_SOCK=%t/ssh-agent" "$unit"
        grep -q "PI_GIT_CONFIG=/home/check/.pi/agent/pi-git.json" "$unit"
        test -f "$homeFiles/.config/systemd/user/pi-git-watcher.timer"
        test -x "${hm.config.home.path}/bin/pi-git-status"
        # One round of the watcher with an empty queue.
        PI_GIT_CONFIG="$homeFiles/$agent/pi-git.json" node "$homeFiles/$agent/extensions/pi-git/watcher.ts" | grep -q "0 PR(s) checked"
        test -f "$(jq -r .skill "$homeFiles/$agent/pi-git.json")/SKILL.md"
        cp "$smoke" smoke.ts
        node smoke.ts "$homeFiles" "$agent"
        touch $out
      '';
}
