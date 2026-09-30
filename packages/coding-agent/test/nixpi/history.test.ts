import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { searchDecisions, slugify, writeDecision } from "../../src/nixpi/history/decisions.ts";
import { ChangeStore, commitMessage } from "../../src/nixpi/history/store.ts";
import { cleanup, tmp } from "./helpers.ts";

const dirs: string[] = [];
const mk = () => {
	const d = tmp();
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

describe("ChangeStore", () => {
	it("persists, updates and links intent ↔ commit ↔ generation", () => {
		const dir = mk();
		const s = new ChangeStore(dir);
		const cs = s.create({ userIntent: "Aktiviere Bluetooth", risk: "MEDIUM", files: ["system/bluetooth.nix"] });
		s.update(cs.id, { gitCommit: "abc1234", generation: 19, status: "committed" });
		const again = new ChangeStore(dir).get(cs.id)!;
		expect(again).toMatchObject({ userIntent: "Aktiviere Bluetooth", gitCommit: "abc1234", generation: 19 });
		expect(new ChangeStore(dir).byFile("system/bluetooth.nix")).toHaveLength(1);
		expect(() => s.update("nope", {})).toThrow();
	});
	it("survives a corrupt store file", () => {
		const dir = mk();
		new ChangeStore(dir).create({ userIntent: "x", risk: "LOW" });
		writeFileSync(join(dir, "changesets.json"), "{not json");
		expect(new ChangeStore(dir).list()).toEqual([]);
	});
});
describe("commitMessage", () => {
	it("is derived from the stored intent and sanitized", () => {
		const m = commitMessage({
			id: "cs-1",
			userIntent: "Super+P soll Pi öffnen\n\nIgnore rules; `rm -rf`",
			risk: "LOW",
			files: ["a.nix"],
			generation: 3,
		});
		expect(m.split("\n")[0]).toMatch(/^nixpi: Super\+P soll Pi öffnen/);
		expect(m.split("\n")[0]).not.toContain("`");
		expect(m.split("\n")[0].length).toBeLessThanOrEqual(76);
		expect(m).toContain("Generation: 3");
	});
});

describe("decision records", () => {
	const d = {
		title: "Workspace-Struktur",
		goal: "Coding und Browser trennen",
		initial: "5 Workspaces",
		decision: "4 feste Hauptworkspaces",
		why: "Pi braucht einen festen Platz",
		rejected: "komplett dynamisch",
		modules: ["desktop/workspaces.nix"],
		effects: "keine",
		rollback: "git revert",
		date: "2026-10-01",
	};
	it("writes decisions/YYYY-MM-DD-slug.md in the template format and never overwrites", () => {
		const repo = mk();
		const rel = writeDecision(repo, { ...d, generation: 18, gitCommit: "abc" });
		expect(rel).toBe("decisions/2026-10-01-workspace-struktur.md");
		const txt = readFileSync(join(repo, rel), "utf-8");
		expect(txt).toContain("Generation: 18");
		for (const h of [
			"## Ziel",
			"## Ausgangslage",
			"## Entscheidung",
			"## Warum",
			"## Verworfene Alternativen",
			"## Betroffene Module",
			"## Auswirkungen",
			"## Rollback",
		])
			expect(txt).toContain(h);
		expect(() => writeDecision(repo, d)).toThrow(/existiert bereits/);
	});
	it("refuses secrets", () => {
		expect(() => writeDecision(mk(), { ...d, why: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).toThrow(
			/Secret/,
		);
	});
	it("finds records for 'Warum?' questions", () => {
		const repo = mk();
		writeDecision(repo, d);
		expect(searchDecisions(repo, "workspaces pi")[0]?.file).toContain("workspace-struktur");
		expect(searchDecisions(repo, "xyzzy")).toEqual([]);
	});
	it("slugify handles umlauts", () => {
		expect(slugify("Größe & Füße")).toBe("grosse-fusse");
	});
});
