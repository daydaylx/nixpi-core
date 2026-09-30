import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRunner } from "../../src/nixpi/exec/runner.ts";
import { ChangeStore } from "../../src/nixpi/history/store.ts";
import { formatRecover, recoverReport } from "../../src/nixpi/recover.ts";
import { cleanup, tmp } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

describe("nixpi recover (no LLM, no network)", () => {
	it("reports generations, git, last good state, health, errors and manual actions", async () => {
		const state = tmp();
		const profiles = tmp();
		dirs.push(state, profiles);
		for (const n of [1, 2]) mkdirSync(join(profiles, `system-${n}-link`));
		symlinkSync(join(profiles, "system-2-link"), join(profiles, "system"));
		const store = new ChangeStore(state);
		const cs = store.create({ userIntent: "Aktiviere Bluetooth", risk: "MEDIUM" });
		store.update(cs.id, {
			status: "committed",
			gitCommit: "abc",
			generation: 2,
			applyResult: { kind: "switch", exitCode: 0, at: "x" },
			healthResult: { ok: true, state: "running", failedUnits: [] },
		});
		const runner = new FakeRunner((cmd, args) => {
			if (cmd === "git" && args[0] === "log") return { stdout: "abc 2026-10-01 nixpi: Aktiviere Bluetooth" };
			if (cmd === "systemctl" && args[0] === "is-system-running") return { stdout: "degraded" };
			if (cmd === "systemctl") return { stdout: "bluetooth.service loaded failed failed BT" };
			if (cmd === "journalctl") return { stdout: "2026-10-01 bluetoothd: error" };
			return { stdout: "" };
		});
		const rep = await recoverReport(runner, { repo: state, host: "h", stateDir: state }, profiles);
		expect(rep.currentGeneration).toBe(2);
		expect(rep.lastSuccessful).toMatchObject({ commit: "abc", generation: 2 });
		expect(rep.health?.ok).toBe(false);
		const txt = formatRecover(rep);
		expect(txt).toContain("Rollback");
		expect(txt).toContain("bluetooth.service");
		expect(txt).toContain("ohne LLM");
		// never calls anything but read-only commands
		expect(runner.calls.every((c) => ["git", "systemctl", "journalctl"].includes(c.cmd))).toBe(true);
	});
});
