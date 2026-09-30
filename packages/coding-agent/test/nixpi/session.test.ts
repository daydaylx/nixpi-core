import { afterEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createAgentSession } from "../../src/core/sdk.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { CHANGE_TOOLS, READ_TOOLS } from "../../src/nixpi/policy/modes.ts";
import { cleanup, tmp } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

/** A real AgentSession wired like the nixpi binary: built-in NixPi extension only. */
async function realSession(opts: { tools?: string[] } = {}) {
	const cwd = tmp();
	const agentDir = tmp();
	dirs.push(cwd, agentDir);
	process.env.NIXPI_CONFIG_REPO = cwd;
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		extensionFactories: builtInExtensions,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		sessionManager: SessionManager.inMemory(),
		tools: opts.tools,
	});
	return session;
}

describe("real AgentSession with the NixPi build", () => {
	it("active tools are exactly the CHANGE set; no bash/edit/write/read", async () => {
		const s = await realSession();
		await s.bindExtensions?.({});
		const names = s.getActiveToolNames();
		expect(names.sort()).toEqual([...READ_TOOLS, ...CHANGE_TOOLS].sort());
		const all = s.getAllTools().map((t) => t.name);
		for (const bad of ["bash", "edit", "write", "read", "powershell", "grep", "find", "ls"])
			expect(all).not.toContain(bad);
	});

	it("an explicit --tools bash cannot bring a shell back", async () => {
		const s = await realSession({ tools: ["bash", "write", "config_read"] });
		await s.bindExtensions?.({});
		const all = s.getAllTools().map((t) => t.name);
		expect(all).not.toContain("bash");
		expect(all).not.toContain("write");
		expect(all).toContain("config_read");
	});
});
