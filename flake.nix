{
  description = "NixPi – NixOS system agent (Pi core fork)";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        nixpi = pkgs.callPackage ./nix/package.nix { };
        default = nixpi;
      });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.nixpi}/bin/nixpi";
        };
      });

      nixosModules.default =
        { pkgs, ... }:
        {
          imports = [ (import ./nix/module.nix { nixpiPackage = self.packages.${pkgs.stdenv.hostPlatform.system}.nixpi; }) ];
        };

      devShells = forAll (pkgs: {
        default = pkgs.mkShell { packages = [ pkgs.nodejs_22 pkgs.git ]; };
      });
    };
}
