import { readFileSync } from "node:fs";
import { configDefaults, defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// Upstream Pi tests that encode Pi identity or Pi defaults NixPi removes on purpose. They still pass on
// the `upstream-baseline-*` tag; see test/nixpi-quarantine.json for the reason of each entry.
const quarantined = (JSON.parse(readFileSync(new URL("./test/nixpi-quarantine.json", import.meta.url), "utf-8")) as Array<{ file: string }>).map((e) => e.file);

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			exclude: [...configDefaults.exclude, ...quarantined],
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
