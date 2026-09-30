import type { ExtensionAPI, ExtensionContext } from "../core/extensions/types.ts";
import { type Runner, SystemRunner } from "./exec/runner.ts";
import { ChangeStore } from "./history/store.ts";
import {
	FallbackKnowledge,
	type KnowledgeBackend,
	LocalNixBackend,
	McpNixosBackend,
	McpStdioClient,
	VerificationLedger,
} from "./nix/knowledge.ts";
import { currentGeneration } from "./nix/ops.ts";
import { type NixpiPaths, resolveNixpiPaths } from "./paths.ts";
import {
	APPLY_TOOLS,
	initialModeState,
	isToolAllowed,
	type ModeEvent,
	type ModeState,
	MUTATION_TOOLS,
	toolsForMode,
	transition,
} from "./policy/modes.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { formatRecover, recoverReport } from "./recover.ts";
import type { NixpiDeps, SessionWork } from "./tools/deps.ts";
import { mutateTools } from "./tools/mutate.ts";
import { knowledgeTools } from "./tools/nixknowledge.ts";
import { planTools } from "./tools/plan.ts";
import { readTools } from "./tools/read.ts";
import { type WebResearchProvider, webProviderFromEnv, webTools } from "./web/provider.ts";

export interface NixpiOverrides {
	paths?: NixpiPaths;
	runner?: Runner;
	knowledge?: KnowledgeBackend;
	web?: WebResearchProvider | null;
}

const MODE_ENTRY = "nixpi-mode";

export function createNixpiExtension(overrides: NixpiOverrides = {}) {
	return function nixpiExtension(pi: ExtensionAPI): void {
		const paths = overrides.paths ?? resolveNixpiPaths();
		const runner = overrides.runner ?? new SystemRunner();
		const web = overrides.web === undefined ? webProviderFromEnv() : (overrides.web ?? undefined);
		const knowledge =
			overrides.knowledge ??
			new FallbackKnowledge([
				new McpNixosBackend(new McpStdioClient(process.env.NIXPI_MCP_NIXOS_CMD || "mcp-nixos", [])),
				new LocalNixBackend(runner, paths.repo, paths.host),
			]);

		let state: ModeState = initialModeState();
		const work: SessionWork = { webTainted: false };
		const ledger = new VerificationLedger();
		const store = new ChangeStore(paths.stateDir);
		let lastCtx: ExtensionContext | undefined;

		const applyTools = () => pi.setActiveTools(toolsForMode(state.mode, { web: !!web }));
		const persist = () => pi.appendEntry(MODE_ENTRY, state);
		const dispatch = (e: ModeEvent) => {
			state = transition(state, e);
			persist();
		};
		const deps: NixpiDeps = {
			paths,
			runner,
			knowledge,
			ledger,
			store,
			work,
			getState: () => state,
			dispatch,
			onModeChanged: () => {
				applyTools();
				if (lastCtx) void refreshStatus(lastCtx);
			},
		};

		for (const t of [
			...readTools(deps),
			...knowledgeTools(deps),
			...planTools(deps),
			...mutateTools(deps),
			...(web
				? webTools(web, () => {
						work.webTainted = true;
					})
				: []),
		])
			pi.registerTool(t);

		async function refreshStatus(ctx: ExtensionContext): Promise<void> {
			lastCtx = ctx;
			try {
				const st = await runner.run("git", ["status", "--porcelain"], { cwd: paths.repo, timeoutMs: 5000 });
				const git = st.code === 0 ? (st.stdout.trim() ? "git:dirty" : "git:clean") : "git:–";
				const gen = currentGeneration();
				const parts = [
					"NixPi",
					state.mode,
					paths.host,
					...(state.mode === "PLAN" ? ["READ ONLY"] : [gen !== undefined ? `Gen ${gen}` : "Gen –", git]),
				];
				ctx.ui.setStatus("nixpi", parts.join(" | "));
			} catch {
				ctx.ui.setStatus("nixpi", `NixPi | ${state.mode} | ${paths.host}`);
			}
		}

		pi.registerFlag("plan", { description: "Im PLAN-Modus (read-only) starten", type: "boolean", default: false });

		pi.on("session_start", async (_e, ctx) => {
			lastCtx = ctx;
			const entries = ctx.sessionManager.getEntries() as Array<{
				type: string;
				customType?: string;
				data?: ModeState;
			}>;
			const saved = entries.filter((e) => e.type === "custom" && e.customType === MODE_ENTRY).at(-1)?.data;
			if (saved && (saved.mode === "CHANGE" || saved.mode === "PLAN"))
				state = { mode: saved.mode, plan: saved.plan, planApproved: !!saved.planApproved };
			else if (pi.getFlag("plan") === true) state = transition(state, { type: "enter_plan" });
			applyTools();
			await refreshStatus(ctx);
		});

		pi.on("before_agent_start", async () => ({
			systemPrompt: buildSystemPrompt({
				mode: state.mode,
				repo: paths.repo,
				host: paths.host,
				web: !!web,
				approvedPlan: state.planApproved ? state.plan?.goal : undefined,
			}),
		}));

		// Defense in depth: the active tool set already matches the mode; block anything else anyway.
		pi.on("tool_call", async (event, ctx) => {
			if (!isToolAllowed(state.mode, event.toolName, { web: !!web }))
				return { block: true, reason: `Tool '${event.toolName}' ist im Modus ${state.mode} nicht erlaubt.` };
			if (work.webTainted && MUTATION_TOOLS.has(event.toolName) && !APPLY_TOOLS.has(event.toolName)) {
				if (!ctx.hasUI)
					return { block: true, reason: "Web-Inhalte im Kontext: Mutation braucht interaktive Bestätigung." };
				const ok = await ctx.ui.confirm(
					"Änderung nach Web-Inhalten",
					`Web-Inhalte sind im Kontext. »${event.toolName}« wirklich ausführen?`,
				);
				if (!ok) return { block: true, reason: "Vom Nutzer nach Web-Inhalten nicht freigegeben." };
			}
			return undefined;
		});

		pi.on("tool_execution_end", async (_e, ctx) => refreshStatus(ctx));

		const setMode = async (ctx: ExtensionContext, m: "CHANGE" | "PLAN") => {
			dispatch({ type: m === "PLAN" ? "enter_plan" : "enter_change" });
			applyTools();
			await refreshStatus(ctx);
			ctx.ui.notify(m === "PLAN" ? "PLAN: strikt read-only." : "CHANGE: Änderungen möglich.", "info");
		};

		pi.registerCommand("plan", {
			description: "In den PLAN-Modus wechseln (read-only)",
			handler: async (_a, ctx) => setMode(ctx, "PLAN"),
		});
		pi.registerCommand("change", {
			description: "In den CHANGE-Modus wechseln",
			handler: async (_a, ctx) => setMode(ctx, "CHANGE"),
		});
		pi.registerCommand("ausfuehren", {
			description: "Fertigen Plan freigeben und in CHANGE ausführen",
			handler: async (_a, ctx) => {
				if (state.mode !== "PLAN" || !state.plan)
					return ctx.ui.notify("Kein fertiger Plan vorhanden (erst /plan und plan_finalize).", "warning");
				if (!(await ctx.ui.confirm("Plan ausführen?", `${state.plan.goal}\nRisiko: ${state.plan.risk}`))) return;
				dispatch({ type: "user_approved_execution" });
				applyTools();
				await refreshStatus(ctx);
				pi.sendUserMessage(`Führe den freigegebenen Plan aus: ${state.plan?.goal}`);
			},
		});
		pi.registerCommand("status", {
			description: "Modus, Host, Generation, Git-Status",
			handler: async (_a, ctx) => {
				const st = await runner.run("git", ["status", "--porcelain=v1", "-b"], {
					cwd: paths.repo,
					timeoutMs: 5000,
				});
				ctx.ui.notify(
					[
						`Modus: ${state.mode}`,
						`Host: ${paths.host}`,
						`Repo: ${paths.repo}`,
						`Generation: ${currentGeneration() ?? "–"}`,
						st.stdout.trim(),
					].join("\n"),
					"info",
				);
			},
		});
		pi.registerCommand("diff", {
			description: "Ungespeicherte Änderungen im Config-Repo",
			handler: async (_a, ctx) => {
				const r = await runner.run("git", ["diff", "HEAD", "--no-color", "--stat"], {
					cwd: paths.repo,
					timeoutMs: 10000,
				});
				ctx.ui.notify(r.stdout.trim() || "Keine Änderungen.", "info");
			},
		});
		pi.registerCommand("history", {
			description: "Letzte NixPi-Änderungen (Intent, Commit, Generation)",
			handler: async (_a, ctx) => {
				const items = store.list(10);
				ctx.ui.notify(
					items.length
						? items
								.map(
									(c) =>
										`${c.createdAt.slice(0, 16)}  ${c.status.padEnd(10)} ${c.risk.padEnd(6)} gen ${c.generation ?? "–"}  ${c.gitCommit ?? "–"}  ${c.userIntent}`,
								)
								.join("\n")
						: "Noch keine Änderungen.",
					"info",
				);
			},
		});
		pi.registerCommand("recover", {
			description: "Recovery-Bericht (ohne LLM)",
			handler: async (_a, ctx) => ctx.ui.notify(formatRecover(await recoverReport(runner, paths)), "info"),
		});
		pi.registerCommand("help", {
			description: "NixPi-Befehle",
			handler: async (_a, ctx) =>
				ctx.ui.notify(
					"/change /plan /ausfuehren /status /diff /history /recover /help\nPLAN ist read-only; CHANGE baut vor jedem Apply.",
					"info",
				),
		});
	};
}

export default createNixpiExtension();
