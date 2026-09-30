# NixPi package (Phase 10).
#
# STATUS: drafted without a Nix toolchain available; NOT yet built.
# First build: `npmDepsHash` is a placeholder. Run `nix build .#nixpi`, copy the hash from the
# error message ("got: sha256-...") into `npmDepsHash`, build again. Further fixes may be needed
# (native optional deps, node version). Track in docs/plan-v2/07 Phase 10.
{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
}:

buildNpmPackage {
  pname = "nixpi";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nodejs = nodejs_22;
  npmDepsHash = lib.fakeHash;

  # Install scripts of optional native addons are not needed (JS fallbacks exist); matches the
  # documented `npm install --ignore-scripts` bootstrap.
  npmFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ makeWrapper ];

  # The upstream monorepo builds all packages in order via the root `build` script.
  npmBuildScript = "build:offline";

  # Not a publishable tarball: install the built tree and wrap the CLI.
  dontNpmInstall = true;
  installPhase = ''
    runHook preInstall
    mkdir -p $out/lib/nixpi $out/bin
    npm prune --omit=dev --ignore-scripts
    cp -r node_modules packages package.json $out/lib/nixpi/
    makeWrapper ${nodejs_22}/bin/node $out/bin/nixpi \
      --add-flags $out/lib/nixpi/packages/coding-agent/dist/bundle/cli.js \
      --set-default PI_SKIP_VERSION_CHECK 1 \
      --set-default PI_TELEMETRY 0
    runHook postInstall
  '';

  meta = {
    description = "NixPi – NixOS system agent (Pi core fork)";
    mainProgram = "nixpi";
    license = lib.licenses.mit;
    platforms = lib.platforms.linux;
  };
}
