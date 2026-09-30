import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/nixpi/exec/runner.ts";
import { call, cleanup, fakeKnowledge, gitRepo, type Harness, harness } from "./helpers.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const c of cleanups.splice(0)) c();
});

function setup(
	opts: {
		files?: Record<string, string>;
		mode?: "CHANGE" | "PLAN";
		knowledge?: ReturnType<typeof fakeKnowledge>;
		runner?: FakeRunner;
	} = {},
): Harness {
	const repo = gitRepo(
		opts.files ?? {
			"desktop/shortcuts.nix": 'bind = "SUPER, F, exec, firefox";\n',
			"system/bluetooth.nix": "{ }\n",
			"secrets.nix": "x",
		},
	);
	const h = harness({ repo, mode: opts.mode, knowledge: opts.knowledge, runner: opts.runner });
	cleanups.push(() => cleanup(repo), h.dispose);
	return h;
}

describe("config_read / config_search", () => {
	it("reads repo files with sha256 and refuses escapes and secrets", async () => {
		const h = setup();
		const r = await call(h, "config_read", { path: "desktop/shortcuts.nix" });
		expect(r.text).toContain(sha('bind = "SUPER, F, exec, firefox";\n'));
		expect((await call(h, "config_read", { path: "../etc/passwd" })).text).toMatch(/^FEHLER/);
		expect((await call(h, "config_read", { path: "/etc/passwd" })).text).toMatch(/^FEHLER/);
		expect((await call(h, "config_read", { path: "secrets.nix" })).text).toMatch(/^FEHLER/);
		expect((await call(h, "config_read", { path: ".git/HEAD" })).text).toMatch(/^FEHLER/);
	});

	it("searches without leaking secret files or .git", async () => {
		const h = setup({ files: { "a.nix": "needle here\n", "secrets.nix": "needle secret\n" } });
		const r = await call(h, "config_search", { query: "needle" });
		expect(r.text).toContain("a.nix:1");
		expect(r.text).not.toContain("secrets.nix");
	});
});

describe("config_patch", () => {
	const OLD = 'bind = "SUPER, F, exec, firefox";\n';
	const args = (_h: Harness, over: Record<string, unknown> = {}) => ({
		path: "desktop/shortcuts.nix",
		expected_sha256: sha(OLD),
		old_text: OLD,
		new_text: `${OLD}bind = "SUPER, P, exec, pi";\n`,
		intent: "Super+P soll Pi öffnen",
		...over,
	});

	it("applies an exact patch atomically, records ChangeSet and patch log", async () => {
		const h = setup();
		const r = await call(h, "config_patch", args(h));
		expect(r.text).toContain("Gepatcht");
		expect(readFileSync(join(h.repo, "desktop/shortcuts.nix"), "utf-8")).toContain("SUPER, P");
		const cs = h.deps.store.latest()!;
		expect(cs).toMatchObject({
			userIntent: "Super+P soll Pi öffnen",
			risk: "LOW",
			files: ["desktop/shortcuts.nix"],
			status: "prepared",
		});
		expect(existsSync(join(h.stateDir, "patches.log"))).toBe(true);
		expect(readFileSync(join(h.stateDir, "patches.log"), "utf-8")).toContain("SUPER, P");
	});

	it("rejects a stale precondition hash", async () => {
		const h = setup();
		const r = await call(h, "config_patch", args(h, { expected_sha256: sha("other") }));
		expect(r.text).toMatch(/sha256 passt nicht/);
		expect(readFileSync(join(h.repo, "desktop/shortcuts.nix"), "utf-8")).toBe(OLD);
	});

	it("requires old_text to occur exactly once", async () => {
		const h = setup({ files: { "x.nix": "a\na\n" } });
		const r = await call(h, "config_patch", {
			path: "x.nix",
			expected_sha256: sha("a\na\n"),
			old_text: "a",
			new_text: "b",
		});
		expect(r.text).toMatch(/genau einmal/);
	});

	it("refuses unverified options/packages until they were verified", async () => {
		const h = setup({ knowledge: fakeKnowledge({ options: ["hardware.bluetooth.enable"], packages: ["firefox"] }) });
		const f = "system/bluetooth.nix";
		const body = {
			path: f,
			expected_sha256: sha("{ }\n"),
			old_text: "{ }",
			new_text: "{ hardware.bluetooth.enable = true; }",
			options: ["hardware.bluetooth.enable"],
		};
		expect((await call(h, "config_patch", body)).text).toMatch(/Nicht verifiziert/);
		expect((await call(h, "nix_option_info", { name: "hardware.bluetooth.enabel" })).text).toMatch(/nicht gefunden/);
		expect(h.deps.ledger.options.has("hardware.bluetooth.enabel")).toBe(false);
		await call(h, "nix_option_info", { name: "hardware.bluetooth.enable" });
		const ok = await call(h, "config_patch", body);
		expect(ok.text).toContain("Gepatcht");
		expect(h.deps.store.latest()!.risk).toBe("MEDIUM");
		expect(h.deps.store.latest()!.verifiedOptions).toEqual(["hardware.bluetooth.enable"]);
	});

	it("blocks secrets in patch content and secret/escape paths", async () => {
		const h = setup();
		const r = await call(h, "config_patch", args(h, { new_text: 'password = "supersecret1";\n' }));
		expect(r.text).toMatch(/Secret/);
		expect((await call(h, "config_patch", args(h, { path: "../outside.nix" }))).text).toMatch(/^FEHLER/);
		expect((await call(h, "config_patch", args(h, { path: ".git/config" }))).text).toMatch(/^FEHLER/);
		expect((await call(h, "config_patch", args(h, { path: "secrets.nix" }))).text).toMatch(/^FEHLER/);
		expect(readFileSync(join(h.repo, "desktop/shortcuts.nix"), "utf-8")).toBe(OLD);
	});

	it("marks HIGH risk changes", async () => {
		const h = setup({ files: { "system/security.nix": "{ }\n" } });
		await call(h, "config_patch", {
			path: "system/security.nix",
			expected_sha256: sha("{ }\n"),
			old_text: "{ }",
			new_text: "{ security.sudo.wheelNeedsPassword = false; }",
		});
		expect(h.deps.store.latest()!.risk).toBe("HIGH");
	});

	it("refuses to run in PLAN mode (defense in depth)", async () => {
		const h = setup({ mode: "PLAN" });
		const r = await call(h, "config_patch", args(h));
		expect(r.text).toMatch(/nur im CHANGE-Modus/);
		expect(readFileSync(join(h.repo, "desktop/shortcuts.nix"), "utf-8")).toBe(OLD);
	});

	it("invalidates an earlier build after a further edit", async () => {
		const h = setup();
		h.deps.work.lastBuild = { changeId: "x", fingerprint: "f", outPath: "/nix/store/x" };
		await call(h, "config_patch", args(h));
		expect(h.deps.work.lastBuild).toBeUndefined();
	});
});

describe("config_create_module", () => {
	it("creates .nix files inside the repo only, never overwrites", async () => {
		const h = setup();
		expect(
			(await call(h, "config_create_module", { path: "desktop/workspaces.nix", content: "{ }\n" })).text,
		).toContain("Angelegt");
		expect(existsSync(join(h.repo, "desktop/workspaces.nix"))).toBe(true);
		expect(
			(await call(h, "config_create_module", { path: "desktop/workspaces.nix", content: "{ }\n" })).text,
		).toMatch(/existiert bereits/);
		expect((await call(h, "config_create_module", { path: "x.txt", content: "" })).text).toMatch(/\.nix/);
		expect((await call(h, "config_create_module", { path: "../x.nix", content: "{ }" })).text).toMatch(/^FEHLER/);
	});
});

describe("Git-Flake handling", () => {
	it("new untracked modules are made visible to the flake via intent-to-add before build", async () => {
		const calls: string[] = [];
		const runner = new FakeRunner((cmd, args) => {
			calls.push(`${cmd} ${args.join(" ")}`);
			if (cmd === "nix") return { code: 0, stdout: "/nix/store/abc-system\n" };
			return undefined;
		});
		const h = setup({ runner });
		// use real git for this one: swap in SystemRunner semantic through ops directly
		const { SystemRunner } = await import("../../src/nixpi/exec/runner.ts");
		const { stageRequired } = await import("../../src/nixpi/nix/ops.ts");
		await call(h, "config_create_module", { path: "desktop/new.nix", content: "{ }\n" });
		writeFileSync(join(h.repo, ".env"), "TOKEN=1");
		const res = await stageRequired(new SystemRunner(), h.repo);
		expect(res.staged).toEqual(["desktop/new.nix"]);
		expect(res.skipped).toContain(".env");
		const { execFileSync } = await import("node:child_process");
		const tracked = execFileSync("git", ["ls-files"], { cwd: h.repo }).toString();
		expect(tracked).toContain("desktop/new.nix");
		expect(tracked).not.toContain(".env");
	});

	it("nix_build stages first, records the build for the current fingerprint", async () => {
		const runner = new FakeRunner((cmd, args) => {
			if (cmd === "git" && args[0] === "ls-files") return { stdout: "desktop/new.nix\0" };
			if (cmd === "git" && args[0] === "rev-parse") return { stdout: "abc\n" };
			if (cmd === "git" && args[0] === "diff") return { stdout: "diff" };
			if (cmd === "nix") return { stdout: "/nix/store/abc-nixos-system\n" };
			return undefined;
		});
		const h = setup({ runner });
		await call(h, "config_create_module", { path: "desktop/new.nix", content: "{ }\n", intent: "neues Modul" });
		const r = await call(h, "nix_build", {});
		expect(JSON.parse(r.text)).toMatchObject({ success: true, derivation: "/nix/store/abc-nixos-system" });
		const order = runner.calls.map((c) => `${c.cmd} ${c.args[0]}`);
		expect(order.indexOf("git add")).toBeGreaterThanOrEqual(0);
		expect(order.indexOf("git add")).toBeLessThan(order.indexOf("nix build"));
		expect(h.deps.work.lastBuild?.outPath).toBe("/nix/store/abc-nixos-system");
		expect(h.deps.store.latest()!.status).toBe("built");
	});

	it("failed builds return structured errors and leave no build record", async () => {
		const runner = new FakeRunner((cmd, args) => {
			if (cmd === "git" && args[0] === "ls-files") return { stdout: "" };
			if (cmd === "nix") return { code: 1, stderr: "error: undefined variable 'foo'\n   at /x/a.nix:3:5\n" };
			return { stdout: "x" };
		});
		const h = setup({ runner });
		await call(h, "config_create_module", { path: "a.nix", content: "{ }\n" });
		const r = await call(h, "nix_build", {});
		const j = JSON.parse(r.text);
		expect(j.success).toBe(false);
		expect(j.errors[0]).toContain("undefined variable");
		expect(h.deps.work.lastBuild).toBeUndefined();
	});
});

describe("apply gate (nix_switch / nix_test / git_commit)", () => {
	const tuiCtx = (confirm: boolean) => ({
		mode: "tui",
		hasUI: true,
		ui: { confirm: async () => confirm, custom: async () => 0 },
	});

	it("refuses without a change, without a current build, and outside TUI", async () => {
		const runner = new FakeRunner((cmd, args) =>
			cmd === "git" && args[0] === "rev-parse" ? { stdout: "abc" } : undefined,
		);
		const h = setup({ runner });
		expect((await call(h, "nix_switch", {})).text).toMatch(/Kein aktives ChangeSet/);
		await call(h, "config_patch", {
			path: "desktop/shortcuts.nix",
			expected_sha256: sha('bind = "SUPER, F, exec, firefox";\n'),
			old_text: "firefox",
			new_text: "kitty",
		});
		expect((await call(h, "nix_switch", {}, tuiCtx(true))).text).toMatch(/Kein erfolgreicher Build/);
		expect((await call(h, "nix_test", {}, tuiCtx(true))).text).toMatch(/Kein erfolgreicher Build/);
	});

	it("HIGH risk needs an approved plan even with a fresh build", async () => {
		const runner = new FakeRunner((cmd, args) =>
			cmd === "git" && args[0] === "rev-parse"
				? { stdout: "abc" }
				: cmd === "git" && args[0] === "diff"
					? { stdout: "d" }
					: undefined,
		);
		const h = setup({ files: { "system/security.nix": "{ }\n" }, runner });
		await call(h, "config_patch", {
			path: "system/security.nix",
			expected_sha256: sha("{ }\n"),
			old_text: "{ }",
			new_text: "{ security.sudo.wheelNeedsPassword = false; }",
		});
		const { repoFingerprint } = await import("../../src/nixpi/nix/ops.ts");
		h.deps.work.lastBuild = {
			changeId: h.deps.work.currentChangeId!,
			fingerprint: await repoFingerprint(runner, h.repo),
			outPath: "/nix/store/x",
		};
		const r = await call(h, "nix_switch", {}, tuiCtx(true));
		expect(r.text).toMatch(/HIGH-Risiko/);
		expect(runner.calls.some((c) => c.cmd === "nh" && c.args[1] === "switch")).toBe(false);
	});

	it("user decline applies nothing", async () => {
		const runner = new FakeRunner((cmd, args) =>
			cmd === "git" && args[0] === "rev-parse"
				? { stdout: "abc" }
				: cmd === "git" && args[0] === "diff"
					? { stdout: "d" }
					: undefined,
		);
		const h = setup({ runner });
		await call(h, "config_patch", {
			path: "desktop/shortcuts.nix",
			expected_sha256: sha('bind = "SUPER, F, exec, firefox";\n'),
			old_text: "firefox",
			new_text: "kitty",
		});
		const { repoFingerprint } = await import("../../src/nixpi/nix/ops.ts");
		h.deps.work.lastBuild = {
			changeId: h.deps.work.currentChangeId!,
			fingerprint: await repoFingerprint(runner, h.repo),
			outPath: "/nix/store/x",
		};
		const r = await call(h, "nix_switch", {}, tuiCtx(false));
		expect(r.text).toMatch(/abgebrochen/);
		expect(h.deps.store.latest()!.applyResult).toBeUndefined();
	});

	it("git_commit needs a current build; message comes from the intent, not from the model", async () => {
		const h = setup();
		await call(h, "config_patch", {
			path: "desktop/shortcuts.nix",
			expected_sha256: sha('bind = "SUPER, F, exec, firefox";\n'),
			old_text: "firefox",
			new_text: "kitty",
			intent: "Kitty statt Firefox",
		});
		expect((await call(h, "git_commit", {})).text).toMatch(/Kein erfolgreicher Build/);
		const { repoFingerprint } = await import("../../src/nixpi/nix/ops.ts");
		h.deps.work.lastBuild = {
			changeId: h.deps.work.currentChangeId!,
			fingerprint: await repoFingerprint(h.runner, h.repo),
			outPath: "/nix/store/x",
		};
		const r = await call(h, "git_commit", {});
		expect(r.text).toContain("nixpi: Kitty statt Firefox");
		const { execFileSync } = await import("node:child_process");
		expect(execFileSync("git", ["log", "-1", "--format=%B"], { cwd: h.repo }).toString()).toContain("ChangeSet: cs-");
		expect(h.deps.store.latest()!.status).toBe("committed");
		expect(h.deps.store.latest()!.gitCommit).toMatch(/^[0-9a-f]+$/);
	});
});

describe("read-only tools", () => {
	it("rejects unsafe unit names for service_status/journal_read", async () => {
		const runner = new FakeRunner(() => ({ stdout: "ok" }));
		const h = setup({ runner });
		expect((await call(h, "service_status", { unit: "--help" })).text).toMatch(/Ungültig/);
		expect((await call(h, "service_status", { unit: "a; rm -rf /" })).text).toMatch(/Ungültig/);
		expect((await call(h, "journal_read", { unit: "-f" })).text).toMatch(/Ungültig/);
		await call(h, "service_status", { unit: "bluetooth.service" });
		expect(runner.calls.at(-1)).toMatchObject({ cmd: "systemctl" });
	});

	it("git_diff validates its path", async () => {
		const h = setup();
		expect((await call(h, "git_diff", { path: "../x" })).text).toMatch(/^FEHLER/);
	});

	it("knowledge outage is reported, not guessed", async () => {
		const failing = {
			...fakeKnowledge(),
			searchOptions: async () => {
				throw new Error("mcp-nixos down");
			},
		};
		const h = setup({ knowledge: failing as never });
		expect((await call(h, "nix_option_search", { query: "bluetooth" })).text).toMatch(/nicht erreichbar/);
	});
});
