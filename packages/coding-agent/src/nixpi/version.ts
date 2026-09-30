import { readFileSync } from "node:fs";
import { getPackageJsonPath } from "../config.ts";

export interface NixpiVersion {
	nixpiVersion: string;
	piUpstreamCommit: string;
	piBaseVersion: string;
}

export function readVersion(): NixpiVersion {
	const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as {
		version?: string;
		nixpi?: { version?: string; upstreamCommit?: string };
	};
	return {
		nixpiVersion: pkg.nixpi?.version ?? "0.0.0",
		piUpstreamCommit: pkg.nixpi?.upstreamCommit ?? "unknown",
		piBaseVersion: pkg.version ?? "unknown",
	};
}

export const formatVersion = (v: NixpiVersion): string =>
	`NixPi ${v.nixpiVersion}\nPi base: ${v.piUpstreamCommit.slice(0, 7)} (pi-coding-agent ${v.piBaseVersion})`;
