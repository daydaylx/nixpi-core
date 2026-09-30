import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../core/extensions/types.ts";
import type { Runner } from "../exec/runner.ts";
import type { ChangeStore } from "../history/store.ts";
import type { KnowledgeBackend, VerificationLedger } from "../nix/knowledge.ts";
import type { NixpiPaths } from "../paths.ts";
import type { ModeEvent, ModeState } from "../policy/modes.ts";

/** Per-session working state shared by tools. */
export interface SessionWork {
	currentChangeId?: string;
	/** Fingerprint + store path of the last successful build, invalidated by any later edit. */
	lastBuild?: { changeId: string; fingerprint: string; outPath: string; host: string };
	/** True after web content entered the context: mutating/apply tools then need fresh user approval. */
	webTainted: boolean;
}

export interface NixpiDeps {
	paths: NixpiPaths;
	runner: Runner;
	knowledge: KnowledgeBackend;
	ledger: VerificationLedger;
	store: ChangeStore;
	work: SessionWork;
	getState(): ModeState;
	dispatch(event: ModeEvent): void;
	/** Switch active tools after a mode transition (set by the extension). */
	onModeChanged(): void;
}

export type AnyTool = ToolDefinition<any, any>;

/** Keeps the parameter schema typed inside `execute`, then erases it for registration. */
export const defineTool = <P extends TSchema>(t: ToolDefinition<P, any>): AnyTool => t as unknown as AnyTool;

export const textResult = <D = undefined>(text: string, details?: D) => ({
	content: [{ type: "text" as const, text }],
	details: details as D,
});

export const errorResult = (text: string) => textResult(`FEHLER: ${text}`, { error: true });

export const clip = (s: string, max = 40_000): string =>
	s.length > max ? `${s.slice(0, max)}\n[… gekürzt, ${s.length - max} Zeichen]` : s;

export const json = (v: unknown): string => JSON.stringify(v, null, 2);
