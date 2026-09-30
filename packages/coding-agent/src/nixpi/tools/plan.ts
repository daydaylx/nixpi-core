import { Type } from "typebox";
import type { Risk } from "../policy/modes.ts";
import { classifyRisk, maxRisk } from "../policy/risk.ts";
import { type AnyTool, defineTool, errorResult, type NixpiDeps, textResult } from "./deps.ts";

export function renderPlan(p: {
	goal: string;
	non_goal: string;
	current_state: string;
	decisions: string[];
	why: string;
	modules: string[];
	risk: Risk;
	effects: string;
	rollback: string;
	open_points: string[];
}): string {
	const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "-");
	return `PLAN FERTIG

Ziel:
${p.goal}

Nicht-Ziel:
${p.non_goal}

Aktueller Zustand:
${p.current_state}

Entscheidungen:
${list(p.decisions)}

Warum:
${p.why}

Betroffene Module:
${list(p.modules)}

Risiko: ${p.risk}

Auswirkungen:
${p.effects}

Rollback:
${p.rollback}

Offene Punkte:
${list(p.open_points)}`;
}

export function planTools(d: NixpiDeps): AnyTool[] {
	const ask = defineTool({
		name: "ask_user",
		label: "Nutzer fragen",
		description:
			"Stellt dem Nutzer eine echte Entscheidungsfrage (nur PLAN). Vorher Zustand lesen; nie nach bereits bekannten Fakten fragen; immer nur die wichtigste Frage. kind: single | multi | text | confirm.",
		promptSnippet: "ask_user: echte Nutzerentscheidung erfragen (PLAN)",
		parameters: Type.Object({
			question: Type.String(),
			kind: Type.Union([
				Type.Literal("single"),
				Type.Literal("multi"),
				Type.Literal("text"),
				Type.Literal("confirm"),
			]),
			options: Type.Optional(Type.Array(Type.String())),
		}),
		executionMode: "sequential",
		async execute(_id, p, signal, _u, ctx) {
			if (d.getState().mode !== "PLAN") return errorResult("ask_user ist nur im PLAN-Modus aktiv.");
			if (ctx.mode === undefined || !ctx.hasUI) return errorResult("Keine interaktive UI verfügbar.");
			const opts = p.options ?? [];
			if ((p.kind === "single" || p.kind === "multi") && opts.length < 2)
				return errorResult("Für Auswahlfragen mindestens 2 Optionen angeben.");
			const o = { signal };
			let answer: unknown;
			if (p.kind === "confirm") answer = await ctx.ui.confirm("NixPi fragt", p.question, o);
			else if (p.kind === "text") answer = await ctx.ui.input(p.question, undefined, o);
			else if (p.kind === "single") answer = await ctx.ui.select(p.question, opts, o);
			else {
				const picked: string[] = [];
				const done = "✓ Fertig";
				for (;;) {
					const rest = opts.filter((x) => !picked.includes(x));
					const a = await ctx.ui.select(
						`${p.question}${picked.length ? ` (gewählt: ${picked.join(", ")})` : ""}`,
						[...rest, done],
						o,
					);
					if (a === undefined || a === done || rest.length === 0) break;
					picked.push(a);
				}
				answer = picked;
			}
			if (answer === undefined)
				return textResult("Der Nutzer hat nicht geantwortet (abgebrochen).", { cancelled: true });
			return textResult(`Antwort des Nutzers: ${typeof answer === "string" ? answer : JSON.stringify(answer)}`, {
				answer,
			});
		},
	});

	const finalize = defineTool({
		name: "plan_finalize",
		label: "Plan abschließen",
		description:
			"Schließt den Plan ab und zeigt ihn dem Nutzer mit [Ausführen] [Bearbeiten] [Abbrechen]. Verändert selbst nichts. Nur der Nutzer kann die Ausführung freigeben.",
		parameters: Type.Object({
			goal: Type.String(),
			non_goal: Type.String(),
			current_state: Type.String(),
			decisions: Type.Array(Type.String()),
			why: Type.String(),
			modules: Type.Array(Type.String({ description: "Betroffene Dateien/Module im Repo" })),
			risk: Type.Union([Type.Literal("LOW"), Type.Literal("MEDIUM"), Type.Literal("HIGH")]),
			effects: Type.String(),
			rollback: Type.String(),
			open_points: Type.Array(Type.String()),
		}),
		executionMode: "sequential",
		async execute(_id, p, _s, _u, ctx) {
			if (d.getState().mode !== "PLAN") return errorResult("plan_finalize ist nur im PLAN-Modus aktiv.");
			const risk = maxRisk(p.risk, classifyRisk(p.modules, `${p.decisions.join("\n")}\n${p.effects}`));
			const plan = { goal: p.goal, summary: p.decisions.join("; "), files: p.modules, risk };
			d.dispatch({ type: "plan_finalized", plan });
			const text = renderPlan({ ...p, risk });
			if (!ctx.hasUI) return textResult(`${text}\n\n(Keine UI: Nutzer muss /ausfuehren eingeben.)`, plan);
			const choice = await ctx.ui.select(`${text}\n\nWie weiter?`, ["Ausführen", "Bearbeiten", "Abbrechen"]);
			if (choice === "Ausführen") {
				d.dispatch({ type: "user_approved_execution" });
				d.onModeChanged();
				return textResult(
					`${text}\n\nDer Nutzer hat die Ausführung freigegeben. Modus ist jetzt CHANGE. Setze den Plan Schritt für Schritt um (verifizieren, patchen, bauen, anwenden, committen, Decision Record).`,
					plan,
				);
			}
			return textResult(
				choice === "Bearbeiten"
					? "Der Nutzer will den Plan bearbeiten: Rückfragen/Anpassungen abwarten, dann erneut plan_finalize."
					: "Plan abgebrochen. Nichts wurde verändert.",
				{ ...plan, choice },
			);
		},
	});

	return [ask, finalize];
}
