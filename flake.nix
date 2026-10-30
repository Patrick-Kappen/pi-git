{
  description = "pi extension that commits, pushes and opens PRs with a helper agent, and watches CI until the PR is green";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      inherit (nixpkgs) lib;
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      # treefmt, so `nix fmt -- --fail-on-change FILES` works (the owner's global pre-commit hook uses it).
      formatter = forAllSystems (pkgs: pkgs.nixfmt-tree);

      checks = forAllSystems (pkgs: {
        formatting = pkgs.runCommand "formatting" { nativeBuildInputs = [ pkgs.nixfmt ]; } ''
          cd ${self}
          nixfmt --check $(find . -name '*.nix' -not -path './.devenv/*')
          touch $out
        '';
      });
    };
}
