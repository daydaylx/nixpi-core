import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/nixpi/exec/runner.ts";
import { FallbackKnowledge, LocalNixBackend, McpNixosBackend, McpStdioClient } from "../../src/nixpi/nix/knowledge.ts";
import { healthcheck, listGenerations, parseGenerationNumber, parseNixOutput } from "../../src/nixpi/nix/ops.ts";
import { cleanup, tmp } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

describe("nix output parsing", () => {
	it("extracts errors with context, warnings and affected units", () => {
		const r = parseNixOutput(
			`warning: Git tree is dirty\nerror: builder for '/nix/store/x.drv' failed\n       unit 'bluetooth.service' misconfigured\nevaluation warning: foo deprecated\n`,
		);
		expect(r.errors[0]).toContain("builder for");
		expect(r.warnings).toHaveLength(2);
		expect(r.affectedUnits).toContain("bluetooth.service");
	});
	it("syntax errors are errors even without an error: prefix", () => {
		expect(parseNixOutput("syntax error, unexpected '}' at x.nix:3:1").errors).toHaveLength(1);
	});
	it("clean output has no errors", () => {
		expect(parseNixOutput("").errors).toEqual([]);
	});
});

describe("generations", () => {
	it("parses links and lists with current marker", () => {
		expect(parseGenerationNumber("/nix/var/nix/profiles/system-18-link")).toBe(18);
		expect(parseGenerationNumber("foo")).toBeUndefined();
		const d = tmp();
		dirs.push(d);
		for (const n of [16, 17, 18]) mkdirSync(join(d, `system-${n}-link`));
		symlinkSync(join(d, "system-18-link"), join(d, "system"));
		const g = listGenerations(d);
		expect(g.map((x) => x.number)).toEqual([16, 17, 18]);
		expect(g.find((x) => x.current)?.number).toBe(18);
	});
});

describe("healthcheck", () => {
	it("ok when running and nothing failed", async () => {
		const r = new FakeRunner((_c, a) => (a[0] === "is-system-running" ? { stdout: "running\n" } : { stdout: "" }));
		expect(await healthcheck(r)).toMatchObject({ ok: true, state: "running" });
	});
	it("not ok with failed units", async () => {
		const r = new FakeRunner((_c, a) =>
			a[0] === "is-system-running" ? { stdout: "degraded\n" } : { stdout: "foo.service loaded failed failed Foo\n" },
		);
		expect(await healthcheck(r)).toMatchObject({ ok: false, failedUnits: ["foo.service"] });
	});
});

describe("mcp-nixos backend", () => {
	const script = join(import.meta.dirname, "fixtures", "fake-mcp.mjs");
	it("talks JSON-RPC over stdio, verifies exact option names", async () => {
		const client = new McpStdioClient(process.execPath, [script], 5000);
		try {
			const b = new McpNixosBackend(client);
			const hits = await b.searchOptions("bluetooth");
			expect(hits.map((h) => h.name)).toContain("hardware.bluetooth.enable");
			expect((await b.optionInfo("hardware.bluetooth.enable"))?.type).toBe("boolean");
			expect(await b.optionInfo("hardware.bluetooth.enabel")).toBeUndefined();
		} finally {
			client.close();
		}
	});

	it("falls back to the local backend when mcp-nixos is unreachable", async () => {
		const dead = new McpNixosBackend(new McpStdioClient("/nonexistent/mcp-nixos", [], 1000));
		const runner = new FakeRunner((cmd, args) =>
			cmd === "nix" && args[0] === "eval"
				? { stdout: JSON.stringify({ type: "boolean", description: "d" }) }
				: undefined,
		);
		const fb = new FallbackKnowledge([dead, new LocalNixBackend(runner, "/repo", "h")]);
		expect(await fb.optionInfo("hardware.bluetooth.enable")).toMatchObject({
			source: "local-nix:eval",
			type: "boolean",
		});
		expect(fb.errors.join()).toContain("mcp-nixos");
	});

	it("reports an error when no backend is reachable at all", async () => {
		const dead = new McpNixosBackend(new McpStdioClient("/nonexistent/mcp-nixos", [], 1000));
		await expect(new FallbackKnowledge([dead]).searchOptions("x")).rejects.toThrow(/Kein Wissens-Backend/);
	});

	it("local backend never interpolates unsafe option names into nix", async () => {
		const runner = new FakeRunner(() => ({ stdout: "{}" }));
		const b = new LocalNixBackend(runner, "/repo", "h");
		expect(await b.optionInfo('x"; builtins.exec')).toBeUndefined();
		expect(runner.calls).toHaveLength(0);
	});
});
