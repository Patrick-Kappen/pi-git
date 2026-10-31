# The pi-git extension: only the files pi loads, no tests.
{
  lib,
  stdenvNoCC,
  version,
}:
let
  src = ../extensions/pi-git;
in
stdenvNoCC.mkDerivation {
  pname = "pi-git";
  inherit version;

  src = lib.fileset.toSource {
    root = src;
    fileset = lib.fileset.unions [
      (lib.fileset.fileFilter (file: file.hasExt "ts" && !lib.hasSuffix ".test.ts" file.name) src)
      (src + "/README.md")
    ];
  };

  dontConfigure = true;
  dontBuild = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out
    cp -r . $out/
    runHook postInstall
  '';

  meta = {
    description = "Pi extension that commits, pushes and opens PRs with a helper agent";
    homepage = "https://github.com/Patrick-Kappen/pi-git";
    license = lib.licenses.mit;
    platforms = lib.platforms.all;
  };
}
