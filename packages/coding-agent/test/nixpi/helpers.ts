import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FakeRunner, type Runner, SystemRunner } from "../../src/nixpi/exec/runner.ts";
import { ChangeStore } from "../../src/nixpi/history/store.ts";
import type { KnowledgeBackend } from "../../src/nixpi/nix/knowledge.ts";
import { VerificationLedger } from "../../src/nixpi/nix/knowledge.ts";
import { initialModeState, type ModeEvent, type ModeState, transition } from "../../src/nixpi/policy/modes.ts";
import type { AnyTool, NixpiDeps } from "../../src/nixpi/tools/deps.ts";
import { mutateTools } from "../../src/nixpi/tools/mutate.ts";
import { knowledgeTools } from "../../src/nixpi/tools/nixknowledge.ts";
import { planTools } from "../../src/nixpi/tools/plan.ts";
import { readTools } from "../../src/nixpi/tools/read.ts";

export const tmp = () => mkdtempSync(join(tmpdir(), "nixpi-test-"));
export const cleanup = (d: string) => rmSync(d, { recursive: true, force: true });

export function writeFiles(root: string, files: Record<string, string>) {
	for (const [rel, c] of Object.entries(files)) {
		mkdirSync(dirname(join(root, rel)), { recursive: true });
		writeFileSync(join(root, rel), c);
	}
}

export function gitRepo(files: Record<string, string>): string {
	const root = tmp();
	writeFiles(root, files);
	const g = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "pipe" });
	g("init", "-q", "-b", "main");
	g("config", "user.email", "t@t");
	g("config", "user.name", "t");
	g("add", "-A");
	g("commit", "-q", "-m", "init");
	return root;
}

export const fakeKnowledge = (opts: { options?: string[]; packages?: string[] } = {}): KnowledgeBackend => ({
	id: "fake",
	async searchOptions(q) {
		return (opts.options ?? []).filter((o) => o.includes(q)).map((name) => ({ name, source: "fake" }));
	},
	async optionInfo(n) {
		return (opts.options ?? []).includes(n) ? { name: n, type: "boolean", source: "fake" } : undefined;
	},
	async searchPackages(q) {
		return (opts.packages ?? []).filter((o) => o.includes(q)).map((name) => ({ name, source: "fake" }));
	},
	async packageInfo(n) {
		return (opts.packages ?? []).includes(n) ? { name: n, source: "fake" } : undefined;
	},
});

export interface Harness {
	deps: NixpiDeps;
	tools: Map<string, AnyTool>;
	state: () => ModeState;
	repo: string;
	stateDir: string;
	runner: Runner;
	dispose(): void;
}

export function harness(opts: {
	repo: string;
	runner?: Runner;
	knowledge?: KnowledgeBackend;
	mode?: "CHANGE" | "PLAN";
}): Harness {
	const stateDir = tmp();
	let state = initialModeState();
	if (opts.mode === "PLAN") state = transition(state, { type: "enter_plan" });
	const runner = opts.runner ?? new SystemRunner();
	const deps: NixpiDeps = {
		paths: { repo: opts.repo, host: "testhost", stateDir },
		runner,
		knowledge: opts.knowledge ?? fakeKnowledge(),
		ledger: new VerificationLedger(),
		store: new ChangeStore(stateDir),
		work: { webTainted: false },
		getState: () => state,
		dispatch: (e: ModeEvent) => {
			state = transition(state, e);
		},
		onModeChanged: () => {},
	};
	const tools = new Map<string, AnyTool>();
	for (const t of [...readTools(deps), ...knowledgeTools(deps), ...planTools(deps), ...mutateTools(deps)])
		tools.set(t.name, t);
	return { deps, tools, state: () => state, repo: opts.repo, stateDir, runner, dispose: () => cleanup(stateDir) };
}

export async function call(
	h: Harness,
	name: string,
	params: unknown,
	ctx: unknown = { mode: "print", hasUI: false, ui: {} },
) {
	const t = h.tools.get(name);
	if (!t) throw new Error(`no tool ${name}`);
	const r = await t.execute("id", params as never, undefined, undefined, ctx as never);
	return { text: (r.content[0] as { text: string }).text, details: r.details as Record<string, unknown> | undefined };
}

export { FakeRunner };
