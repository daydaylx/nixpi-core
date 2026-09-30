import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { getAgentDir } from "../config.ts";

/** Where NixPi keeps its declarative source of truth and its own state. */
export interface NixpiPaths {
	/** `~/nixos-config` unless `NIXPI_CONFIG_REPO` is set. */
	repo: string;
	/** Flake host attribute (`nixosConfigurations.<host>`), `NIXPI_HOST` or the machine hostname. */
	host: string;
	/** NixPi state dir (inside the NixPi agent dir, never `~/.pi`). */
	stateDir: string;
}

export function resolveNixpiPaths(env: NodeJS.ProcessEnv = process.env): NixpiPaths {
	return {
		repo: env.NIXPI_CONFIG_REPO || join(homedir(), "nixos-config"),
		host: env.NIXPI_HOST || hostname(),
		stateDir: join(getAgentDir(), "nixpi"),
	};
}
