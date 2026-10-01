import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FreshSystem } from "./detect.ts";

export interface BootstrapOptions {
	repo: string;
	sys: FreshSystem;
	/** Flake reference of NixPi itself (e.g. `github:owner/nixpi-core`). Omitted => NixPi is not declared yet. */
	nixpiFlake?: string;
}

const safeIdent = (s: string) => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s);

export function nixpkgsBranch(versionId?: string): string {
	const m = versionId?.match(/^(\d{2}\.\d{2})/);
	return m ? `nixos-${m[1]}` : "nixos-unstable";
}

/**
 * `systemConfig` is the existing `/etc/nixos/configuration.nix`. When given it is carried over verbatim
 * (bootloader, networking, locale, users, ...) so the managed repo describes the same system; without it
 * the host module would lack e.g. a bootloader and the generation would not evaluate.
 */
export function renderFiles(
	o: BootstrapOptions,
	hardwareConfig: string,
	systemConfig?: string,
): Record<string, string> {
	const { sys } = o;
	if (!safeIdent(sys.host)) throw new Error(`Hostname nicht als Nix-Attribut verwendbar: ${sys.host}`);
	if (!safeIdent(sys.user)) throw new Error(`Benutzername nicht verwendbar: ${sys.user}`);
	if (!sys.stateVersion)
		throw new Error("system.stateVersion in /etc/nixos/configuration.nix nicht gefunden – bitte manuell angeben.");
	const branch = nixpkgsBranch(sys.versionId);
	const hmRef = branch === "nixos-unstable" ? "master" : `release-${branch.slice(6)}`;
	const hasNixpi = !!o.nixpiFlake;
	return {
		"flake.nix": `{
  description = "NixOS-Konfiguration, verwaltet mit NixPi";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/${branch}";
    home-manager = {
      url = "github:nix-community/home-manager/${hmRef}";
      inputs.nixpkgs.follows = "nixpkgs";
    };${
			hasNixpi
				? `
    nixpi = {
      url = "${o.nixpiFlake}";
      inputs.nixpkgs.follows = "nixpkgs";
    };`
				: ""
		}
  };

  outputs = { nixpkgs, home-manager, ${hasNixpi ? "nixpi, " : ""}... }: {
    nixosConfigurations.${sys.host} = nixpkgs.lib.nixosSystem {
      system = "${sys.system}";
      specialArgs = { ${hasNixpi ? "inherit nixpi; " : ""}};
      modules = [
        ./hosts/${sys.host}
        home-manager.nixosModules.home-manager
      ];
    };
  };
}
`,
		[`hosts/${sys.host}/default.nix`]: `{ ${hasNixpi ? "nixpi, " : ""}pkgs, ... }:
{
  imports = [
${
	systemConfig
		? "    ./configuration.nix # übernommen aus /etc/nixos (importiert die hardware-configuration.nix)\n"
		: "    ./hardware-configuration.nix\n"
}    ../../system/base.nix
  ];
${
	systemConfig
		? ""
		: `
  networking.hostName = "${sys.host}";
  system.stateVersion = "${sys.stateVersion}";

  users.users.${sys.user}.isNormalUser = true;
  users.users.${sys.user}.extraGroups = [ "wheel" "networkmanager" ];
`
}
  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    users.${sys.user} = import ../../home/default.nix;
  };
${
	hasNixpi
		? `
  # NixPi selbst deklarativ installieren
  environment.systemPackages = [ nixpi.packages.\${pkgs.stdenv.hostPlatform.system}.default ];
`
		: ""
}}
`,
		[`hosts/${sys.host}/hardware-configuration.nix`]: hardwareConfig,
		...(systemConfig ? { [`hosts/${sys.host}/configuration.nix`]: systemConfig } : {}),
		"system/base.nix": `{ pkgs, ... }:
{
  nix.settings.experimental-features = [ "nix-command" "flakes" ];

  programs.nh.enable = true;
  environment.systemPackages = with pkgs; [
    git
    mcp-nixos
  ];
}
`,
		"home/default.nix": `{ pkgs, ... }:
{
  imports = [ ./programs.nix ];
  home.stateVersion = "${sys.stateVersion}";
}
`,
		"home/programs.nix": `{ pkgs, ... }:
{
  programs.git.enable = true;
  home.packages = [ ];
}
`,
		"decisions/.gitkeep": "",
		".gitignore": "result\nresult-*\n.direnv/\n*.nixpi-*.tmp\n",
		"README.md": `# NixOS-Konfiguration (${sys.host})

Source of Truth für dieses System, verwaltet mit NixPi. Auch ohne NixPi manuell nutzbar:

\`\`\`sh
nh os build . --hostname ${sys.host}
nh os switch . --hostname ${sys.host}
\`\`\`

Aufbau: \`hosts/\` (hostspezifisch), \`system/\` (Betriebssystem), \`home/\` (Home Manager), \`decisions/\` (Entscheidungen).
`,
	};
}

export interface BootstrapResult {
	written: string[];
	committed: boolean;
}

/** Writes the skeleton, runs `git init` and stages everything. Refuses if the target exists and is non-empty. */
export function writeRepo(o: BootstrapOptions): BootstrapResult {
	if (!o.sys.hasHardwareConfig) throw new Error(`${o.sys.hardwareConfigPath} nicht gefunden.`);
	if (existsSync(o.repo) && readdirSync(o.repo).length > 0)
		throw new Error(`${o.repo} existiert bereits und ist nicht leer.`);
	const systemConfigPath = join(dirname(o.sys.hardwareConfigPath), "configuration.nix");
	const files = renderFiles(
		o,
		readFileSync(o.sys.hardwareConfigPath, "utf-8"),
		existsSync(systemConfigPath) ? readFileSync(systemConfigPath, "utf-8") : undefined,
	);
	const written: string[] = [];
	for (const [rel, content] of Object.entries(files)) {
		const abs = join(o.repo, rel);
		mkdirSync(dirname(abs), { recursive: true });
		writeFileSync(abs, content);
		written.push(rel);
	}
	const git = (...args: string[]) => execFileSync("git", args, { cwd: o.repo, stdio: "pipe" });
	git("init", "-q", "-b", "main");
	git("add", "-A");
	let committed = false;
	try {
		git("commit", "-q", "-m", "nixpi: Initiales verwaltetes NixOS-Repo aus /etc/nixos");
		committed = true;
	} catch {
		/* no git identity configured: files stay staged */
	}
	return { written, committed };
}
