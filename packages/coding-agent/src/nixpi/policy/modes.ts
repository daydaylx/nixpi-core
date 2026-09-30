/** Exactly two modes. Diagnosis is a task type inside CHANGE, not a mode. */
export type NixpiMode = "CHANGE" | "PLAN";

/** Always-available read-only tools (both modes). */
export const READ_TOOLS = [
	"system_snapshot",
	"config_read",
	"config_search",
	"git_status",
	"git_diff",
	"nix_option_search",
	"nix_option_info",
	"package_search",
	"package_info",
	"service_status",
	"journal_read",
	"generation_list",
	"history_list",
	"decision_search",
] as const;

/** Only active in PLAN. */
export const PLAN_TOOLS = ["ask_user", "plan_finalize"] as const;

/** Only active in CHANGE. Everything here can mutate the repo, the index or the system. */
export const CHANGE_TOOLS = [
	"config_patch",
	"config_create_module",
	"git_stage_required",
	"nix_eval",
	"nix_check",
	"nix_build",
	"nix_test",
	"nix_switch",
	"generation_rollback",
	"git_commit",
	"decision_write",
] as const;

/** Optional read-only web tools (only registered when web research is enabled). */
export const WEB_TOOLS = ["web_search", "web_fetch"] as const;

/** Tools that must never be reachable from PLAN, including the privileged ones. */
export const MUTATION_TOOLS: ReadonlySet<string> = new Set(CHANGE_TOOLS);

/** Tools that change the running system or the repo history irreversibly enough to need a fresh user confirmation after untrusted web content was read. */
export const APPLY_TOOLS: ReadonlySet<string> = new Set([
	"nix_test",
	"nix_switch",
	"generation_rollback",
	"git_commit",
]);

export function toolsForMode(mode: NixpiMode, opts: { web?: boolean } = {}): string[] {
	const web: string[] = opts.web ? [...WEB_TOOLS] : [];
	return mode === "PLAN" ? [...READ_TOOLS, ...web, ...PLAN_TOOLS] : [...READ_TOOLS, ...web, ...CHANGE_TOOLS];
}

export function isToolAllowed(mode: NixpiMode, name: string, opts: { web?: boolean } = {}): boolean {
	return toolsForMode(mode, opts).includes(name);
}

/** A finished plan that may be handed over to CHANGE. */
export interface FinalPlan {
	goal: string;
	summary: string;
	files: string[];
	risk: Risk;
}

export type Risk = "LOW" | "MEDIUM" | "HIGH";

export interface ModeState {
	mode: NixpiMode;
	/** Set by `plan_finalize`; required as the basis for a HIGH-risk CHANGE. */
	plan?: FinalPlan;
	/** True once the user explicitly approved executing `plan`. */
	planApproved: boolean;
}

export const initialModeState = (): ModeState => ({ mode: "CHANGE", planApproved: false });

export type ModeEvent =
	| { type: "enter_plan" }
	| { type: "enter_change" }
	| { type: "plan_finalized"; plan: FinalPlan }
	/** Only emitted from an explicit user action ("Ausführen" / UI confirmation). */
	| { type: "user_approved_execution" };

/**
 * Pure transition function. PLAN → CHANGE with an approved plan happens only through
 * `user_approved_execution`; the model cannot trigger it.
 */
export function transition(state: ModeState, event: ModeEvent): ModeState {
	switch (event.type) {
		case "enter_plan":
			return { mode: "PLAN", planApproved: false };
		case "enter_change":
			// Explicit user switch without executing a plan discards the plan.
			return { mode: "CHANGE", planApproved: false };
		case "plan_finalized":
			return state.mode === "PLAN" ? { ...state, plan: event.plan, planApproved: false } : state;
		case "user_approved_execution":
			if (state.mode === "PLAN" && state.plan) return { mode: "CHANGE", plan: state.plan, planApproved: true };
			return state;
	}
}
