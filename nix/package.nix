# NixPi package (Phase 10).
#
# Build with `nix build .#nixpi`. After changing package-lock.json, set `npmDepsHash` to
# `lib.fakeHash`, build once and copy the "got: sha256-..." value back.
{
  lib,
  buildNpmPackage,
  nodejs_22,
  makeWrapper,
  git,
  nh,
  mcp-nixos,
}:

buildNpmPackage {
  pname = "nixpi";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  nodejs = nodejs_22;
  npmDepsHash = "sha256-eKghIpCAKawZm0Uf2iG6y1fz21Z5jNnMiAFJ5Quj3GI=";

  # Install scripts of optional native addons are not needed (JS fallbacks exist); matches the
  # documented `npm install --ignore-scripts` bootstrap.
  npmFlags = [ "--ignore-scripts" ];
  nativeBuildInputs = [ makeWrapper ];

  # The model catalog is generated over the network upstream (gitignored); use the vendored snapshot.
  postPatch = ''
    mkdir -p packages/ai/src/providers/data
    cp -r --no-preserve=mode nix/model-data/. packages/ai/src/providers/data/
    rm -f packages/ai/src/providers/data/README.md
  '';

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
      --suffix PATH : ${lib.makeBinPath [ git nh mcp-nixos ]} \
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
