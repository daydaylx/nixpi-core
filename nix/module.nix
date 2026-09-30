# Optional NixOS module: installs NixPi and `mcp-nixos`. No daemon, no root service,
# no sudo rules (NixPi uses the user's normal sudo prompt for the apply step).
{ nixpiPackage }:
{ lib, config, pkgs, ... }:
let
  cfg = config.programs.nixpi;
in
{
  options.programs.nixpi = {
    enable = lib.mkEnableOption "NixPi, the NixOS system agent";
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [
      nixpiPackage
      pkgs.mcp-nixos
      pkgs.nh
      pkgs.git
    ];
  };
}
