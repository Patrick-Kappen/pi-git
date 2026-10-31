# pi-git-status: a red mark with the number of things that need you, for the tmux status line.
{ writeShellApplication }:
writeShellApplication {
  name = "pi-git-status";
  text = ''
    dir="''${PI_GIT_STATE_DIR:-''${XDG_STATE_HOME:-$HOME/.local/state}/pi-git}/attention"
    count=0
    for file in "$dir"/*.json; do
      if [ -e "$file" ]; then
        count=$((count + 1))
      fi
    done
    if [ "$count" -gt 0 ]; then
      printf '#[fg=red]● %s#[default] ' "$count"
    fi
  '';
}
