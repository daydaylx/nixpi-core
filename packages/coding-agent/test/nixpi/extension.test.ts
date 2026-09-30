import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_TOOL_NAMES } from "../../src/core/settings-manager.ts";
import { builtInExtensions } from "../../src/extensions/index.ts";
import { FakeRunner } from "../../src/nixpi/exec/runner.ts";
import { createNixpiExtension } from "../../src/nixpi/extension.ts";
import { CHANGE_TOOLS, PLAN_TOOLS, READ_TOOLS, WEB_TOOLS } from "../../src/nixpi/policy/modes.ts";
import { cleanup, fakeKnowledge, tmp } from "./helpers.ts";

type Handler = (event: any, ctx: any) => any;

/** Minimal stand-in for the ExtensionAPI surface NixPi uses. */
function fakePi() {
	const tools = new Map<string, any>();
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, any>();
	const entries: Array<{ customType: string; data: unknown }> = [];
	let active: string[] = [];
	const pi: any = {
		registerTool: (t: any) => tools.set(t.name, t),
		registerCommand: (n: string, o: any) => commands.set(n, o),
		registerFlag: () => {},
		getFlag: () => false,
		on: (e: string, h: Handler) => handlers.set(e, h),
		setActiveTools: (n: string[]) => {
			active = n;
		},
		getActiveTools: () => active,
		appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
		sendUserMessage: () => {},
	};
	return { pi, tools, handlers, commands, entries, active: () => active };
}

const uiCtx = (over: Record<string, unknown> = {}) => {
	const notes: string[] = [];
	return {
		notes,
		ctx: {
			mode: "tui",
			hasUI: true,
			sessionManager: { getEntries: () => [] },
			ui: {
				setStatus: () => {},
				notify: (m: string) => notes.push(m),
				confirm: async () => true,
				select: async () => "Ausführen",
				input: async () => "x",
				...over,
			},
		},
	};
};

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

function boot(web = false) {
	const fp = fakePi();
	const dir = tmp();
	dirs.push(dir);
	const runner = new FakeRunner(() => ({ stdout: "" }));
	createNixpiExtension({
		paths: { repo: dir, host: "h", stateDir: dir },
		runner,
		knowledge: fakeKnowledge(),
		web: web ? ({ id: "x", search: async () => [], fetch: async () => "" } as never) : null,
	})(fp.pi);
	return { ...fp, runner };
}

describe("fork identity and tool boundary", () => {
	it("only the NixPi extension is built in; no built-in coding tools are default", () => {
		expect(builtInExtensions.map((e) => e.name)).toEqual(["nixpi"]);
		expect(DEFAULT_TOOL_NAMES).toEqual([]);
	});
	it("registers exactly the documented tool set (no bash/write/edit)", () => {
		const { tools } = boot();
		const names = [...tools.keys()].sort();
		expect(names).toEqual([...READ_TOOLS, ...PLAN_TOOLS, ...CHANGE_TOOLS].sort());
		for (const bad of ["bash", "write", "edit", "read"]) expect(names).not.toContain(bad);
	});
	it("web tools exist only when a provider is configured", () => {
		expect([...boot(false).tools.keys()]).not.toContain("web_search");
		const w = boot(true);
		for (const t of WEB_TOOLS) expect(w.tools.has(t)).toBe(true);
	});
});

describe("modes through the extension", () => {
	it("starts in CHANGE with mutation tools, PLAN swaps them out", async () => {
		const b = boot();
		const { ctx, notes } = uiCtx();
		await b.handlers.get("session_start")!({}, ctx);
		expect(b.active()).toContain("config_patch");
		expect(b.active()).not.toContain("ask_user");
		await b.commands.get("plan").handler("", ctx);
		expect(b.active()).not.toContain("config_patch");
		expect(b.active()).not.toContain("nix_switch");
		expect(b.active()).toContain("ask_user");
		expect(notes.at(-1)).toMatch(/read-only/);
		await b.commands.get("change").handler("", ctx);
		expect(b.active()).toContain("config_patch");
	});

	it("blocks tools outside the active mode even if the model calls them", async () => {
		const b = boot();
		const { ctx } = uiCtx();
		await b.handlers.get("session_start")!({}, ctx);
		await b.commands.get("plan").handler("", ctx);
		const r = await b.handlers.get("tool_call")!({ toolName: "nix_switch", input: {} }, ctx);
		expect(r).toMatchObject({ block: true });
		expect(await b.handlers.get("tool_call")!({ toolName: "bash", input: {} }, ctx)).toMatchObject({ block: true });
		// tools that belong to the mode pass
		expect(await b.handlers.get("tool_call")!({ toolName: "ask_user", input: {} }, ctx)).toBeUndefined();
		await b.commands.get("change").handler("", ctx);
		expect(await b.handlers.get("tool_call")!({ toolName: "ask_user", input: {} }, ctx)).toMatchObject({
			block: true,
		});
	});

	it("persists the mode and restores it on resume", async () => {
		const b = boot();
		const { ctx } = uiCtx();
		await b.handlers.get("session_start")!({}, ctx);
		await b.commands.get("plan").handler("", ctx);
		const saved = b.entries.filter((e) => e.customType === "nixpi-mode").at(-1)!;
		const b2 = boot();
		const c2 = uiCtx();
		c2.ctx.sessionManager.getEntries = () =>
			[{ type: "custom", customType: "nixpi-mode", data: saved.data }] as never;
		await b2.handlers.get("session_start")!({}, c2.ctx);
		expect(b2.active()).not.toContain("config_patch");
		expect(b2.active()).toContain("plan_finalize");
	});

	it("system prompt reflects the mode and forbids shell/invented options", async () => {
		const b = boot();
		const { ctx } = uiCtx();
		await b.handlers.get("session_start")!({}, ctx);
		const change = (await b.handlers.get("before_agent_start")!({}, ctx)).systemPrompt as string;
		expect(change).toContain("Aktueller Modus: CHANGE");
		expect(change).toMatch(/Keine freie Shell/);
		await b.commands.get("plan").handler("", ctx);
		const plan = (await b.handlers.get("before_agent_start")!({}, ctx)).systemPrompt as string;
		expect(plan).toContain("Aktueller Modus: PLAN (strikt read-only)");
		expect(plan).toContain("ask_user");
	});

	it("plan_finalize: user approval moves PLAN -> CHANGE; declining stays in PLAN", async () => {
		const plan = {
			goal: "Workspaces",
			non_goal: "-",
			current_state: "5 Workspaces",
			decisions: ["4 feste"],
			why: "w",
			modules: ["desktop/workspaces.nix"],
			risk: "LOW",
			effects: "e",
			rollback: "r",
			open_points: [],
		};
		const b = boot();
		const no = uiCtx({ select: async () => "Abbrechen" });
		await b.handlers.get("session_start")!({}, no.ctx);
		await b.commands.get("plan").handler("", no.ctx);
		const r1 = await b.tools.get("plan_finalize").execute("1", plan, undefined, undefined, no.ctx);
		expect(r1.content[0].text).toMatch(/abgebrochen/);
		expect(b.active()).not.toContain("config_patch");
		const yes = uiCtx({ select: async () => "Ausführen" });
		const r2 = await b.tools.get("plan_finalize").execute("2", plan, undefined, undefined, yes.ctx);
		expect(r2.content[0].text).toMatch(/freigegeben/);
		expect(b.active()).toContain("config_patch");
		const prompt = (await b.handlers.get("before_agent_start")!({}, yes.ctx)).systemPrompt as string;
		expect(prompt).toContain("Freigegebener Plan");
	});

	it("/ausfuehren requires a finished plan", async () => {
		const b = boot();
		const { ctx, notes } = uiCtx();
		await b.handlers.get("session_start")!({}, ctx);
		await b.commands.get("plan").handler("", ctx);
		await b.commands.get("ausfuehren").handler("", ctx);
		expect(notes.at(-1)).toMatch(/Kein fertiger Plan/);
		expect(b.active()).not.toContain("config_patch");
	});

	it("ask_user is refused in CHANGE", async () => {
		const b = boot();
		const { ctx } = uiCtx();
		await b.handlers.get("session_start")!({}, ctx);
		const r = await b.tools
			.get("ask_user")
			.execute("1", { question: "?", kind: "confirm" }, undefined, undefined, ctx);
		expect(r.content[0].text).toMatch(/nur im PLAN/);
	});

	it("ask_user multi-select collects choices until done", async () => {
		const b = boot();
		const answers = ["a", "b", "✓ Fertig"];
		const { ctx } = uiCtx({ select: async () => answers.shift() });
		await b.handlers.get("session_start")!({}, ctx);
		await b.commands.get("plan").handler("", ctx);
		const r = await b.tools
			.get("ask_user")
			.execute("1", { question: "?", kind: "multi", options: ["a", "b", "c"] }, undefined, undefined, ctx);
		expect(r.details.answer).toEqual(["a", "b"]);
	});

	it("after web content, mutations need fresh user confirmation", async () => {
		const b = boot(true);
		const deny = uiCtx({ confirm: async () => false });
		await b.handlers.get("session_start")!({}, deny.ctx);
		await b.tools.get("web_search").execute("1", { query: "q" }, undefined, undefined, deny.ctx);
		const blocked = await b.handlers.get("tool_call")!({ toolName: "config_patch", input: {} }, deny.ctx);
		expect(blocked).toMatchObject({ block: true });
		const allow = uiCtx({ confirm: async () => true });
		expect(await b.handlers.get("tool_call")!({ toolName: "config_patch", input: {} }, allow.ctx)).toBeUndefined();
		// read tools stay free
		expect(await b.handlers.get("tool_call")!({ toolName: "config_read", input: {} }, deny.ctx)).toBeUndefined();
	});
});
