import { Type } from "typebox";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { runWithTerminal } from "../exec/interactive.ts";
import type { NixpiMode } from "../policy/modes.ts";
import { defineTool, errorResult, textResult } from "./deps.ts";

export type AdminExecutor = (ctx: ExtensionContext, command: string) => Promise<number | null | undefined>;

const GENERIC_REASONS = new Set(["needed", "necessary", "required", "admin command"]);
const GENERIC_RISKS = new Set(["none", "low", "medium", "high", "no risk", "unknown", "n/a"]);

function hasConcreteDescription(text: string | undefined, generic: ReadonlySet<string>): text is string {
	if (!text) return false;
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/[.!?]+$/, "");
	return normalized.length >= 12 && !generic.has(normalized);
}

/** Dialog text comes from the model and is rendered raw; reject anything that could rewrite or hide what the user reads. */
function hasUnsafeDisplayChars(text: string): boolean {
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		if (c === 0x0a || c === 0x09) continue;
		if (c < 0x20 || (c >= 0x7f && c <= 0x9f)) return true;
		if (c === 0x2028 || c === 0x2029 || (c >= 0x200b && c <= 0x200f) || (c >= 0x202a && c <= 0x202e)) return true;
		if ((c >= 0x2066 && c <= 0x2069) || c === 0xfeff) return true;
	}
	return false;
}

async function executeAdminCommand(ctx: ExtensionContext, command: string): Promise<number | null | undefined> {
	if (ctx.mode !== "tui") return undefined;
	const env = { ...process.env };
	delete env.BASH_ENV;
	return runWithTerminal(ctx, "bash", ["--noprofile", "--norc", "-c", command], ctx.cwd, env);
}

export function adminExecTool(
	isAdminMode: () => boolean,
	getMode: () => NixpiMode,
	executor: AdminExecutor = executeAdminCommand,
) {
	return defineTool({
		name: "admin_exec",
		label: "Admin-Shell",
		description:
			"Führt im aktivierten Adminmode einen Shell-Befehl als aktueller Betriebssystemnutzer aus. Jeder Aufruf benötigt einzeln interaktive Bestätigung. command, reason und risk angeben; sudo fragt separat direkt im Terminal nach OS-Authentifizierung. Ausgabe bleibt im Terminal; an das Modell geht nur der Exit-Status.",
		promptSnippet: "admin_exec: Shell-Befehl mit Grund und konkretem Risiko einzeln bestätigen lassen",
		parameters: Type.Object({
			command: Type.String({ description: "Exakter Shell-Befehl, der nach Freigabe ausgeführt wird." }),
			reason: Type.Optional(
				Type.String({ description: "Warum der Befehl nötig ist und welches Ziel er erreicht." }),
			),
			risk: Type.Optional(
				Type.String({ description: "Konkrete mögliche Folgen, falls der Befehl scheitert oder anders wirkt." }),
			),
		}),
		annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!isAdminMode() || getMode() !== "CHANGE")
				return errorResult("Administrative Aktion abgelehnt: Adminmode ist aus oder PLAN ist aktiv.");
			if (ctx.mode !== "tui" || !ctx.hasUI)
				return errorResult("Administrative Aktion abgelehnt: interaktive TUI-Freigabe erforderlich.");
			if (
				!params.command.trim() ||
				!hasConcreteDescription(params.reason, GENERIC_REASONS) ||
				!hasConcreteDescription(params.risk, GENERIC_RISKS)
			)
				return errorResult(
					"Administrative Aktion abgelehnt. Eine konkrete Begründung und Risikoanalyse sind erforderlich; bitte den Tool-Aufruf korrigieren.",
				);
			if ([params.command, params.reason, params.risk].some(hasUnsafeDisplayChars))
				return errorResult(
					"Administrative Aktion abgelehnt: command, reason und risk dürfen keine Steuerzeichen enthalten.",
				);

			const command = params.command;
			const reason = params.reason.trim();
			const risk = params.risk.trim();
			let approved: boolean;
			try {
				approved = await ctx.ui.confirm(
					"ADMINISTRATIVE AKTION",
					`Befehl:\n${command}\n\nBegründung:\n${reason}\n\nRisiko:\n${risk}\n\nNur dieser Befehl wird ausgeführt. Eine sudo-Authentifizierung bleibt separat.`,
				);
			} catch {
				return errorResult("Administrative Aktion abgelehnt: Freigabe-Dialog fehlgeschlagen.");
			}
			if (!approved)
				return textResult("Administrative Aktion abgelehnt. Der Befehl wurde nicht ausgeführt.", {
					approved: false,
				});
			if (!isAdminMode() || getMode() !== "CHANGE")
				return errorResult("Administrative Aktion abgelehnt: Adminmode wurde deaktiviert oder PLAN ist aktiv.");

			try {
				const exitCode = await executor(ctx, command);
				if (exitCode === undefined)
					return errorResult(
						"Administrative Aktion abgelehnt: Ausführung ist ohne interaktive TUI nicht möglich.",
					);
				if (exitCode === null)
					return errorResult("Befehl wurde freigegeben, aber die Shell lieferte keinen Exit-Code.");
				return textResult(`Befehl beendet (Exit-Code ${exitCode}). Ausgabe ist nur im Terminal sichtbar.`, {
					approved: true,
					exitCode,
				});
			} catch {
				return errorResult("Befehl wurde freigegeben, konnte aber nicht ausgeführt werden.");
			}
		},
	});
}
