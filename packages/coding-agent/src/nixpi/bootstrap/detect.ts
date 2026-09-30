import { existsSync, readFileSync } from "node:fs";
import { arch, hostname, userInfo } from "node:os";
import { join } from "node:path";

export interface FreshSystem {
	isNixos: boolean;
	versionId?: string;
	host: string;
	user: string;
	system: string;
	stateVersion?: string;
	hasHardwareConfig: boolean;
	hardwareConfigPath: string;
	configExists: boolean;
}

export function parseOsRelease(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const l of text.split("\n")) {
		const m = l.match(/^([A-Z_]+)=(?:"([^"]*)"|(.*))$/);
		if (m) out[m[1]!] = m[2] ?? m[3] ?? "";
	}
	return out;
}

export function parseStateVersion(nixText: string): string | undefined {
	return nixText.match(/system\.stateVersion\s*=\s*"([^"]+)"/)?.[1];
}

const SYSTEMS: Record<string, string> = { x64: "x86_64-linux", arm64: "aarch64-linux" };

/** Reads only: /etc/os-release, /etc/nixos, hostname, current user. */
export function detectSystem(opts: { etcDir?: string; configRepo: string }): FreshSystem {
	const etc = opts.etcDir ?? "/etc";
	const osr = existsSync(join(etc, "os-release"))
		? parseOsRelease(readFileSync(join(etc, "os-release"), "utf-8"))
		: {};
	const nixosDir = join(etc, "nixos");
	const conf = join(nixosDir, "configuration.nix");
	const hw = join(nixosDir, "hardware-configuration.nix");
	return {
		isNixos: osr.ID === "nixos",
		versionId: osr.VERSION_ID,
		host: hostname(),
		user: userInfo().username,
		system: SYSTEMS[arch()] ?? "x86_64-linux",
		stateVersion: existsSync(conf) ? parseStateVersion(readFileSync(conf, "utf-8")) : undefined,
		hasHardwareConfig: existsSync(hw),
		hardwareConfigPath: hw,
		configExists: existsSync(opts.configRepo),
	};
}
