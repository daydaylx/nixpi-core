import { Type } from "typebox";
import { type AnyTool, defineTool, errorResult, json, type NixpiDeps, textResult } from "./deps.ts";

export function knowledgeTools(d: NixpiDeps): AnyTool[] {
	const wrap = async <T>(fn: () => Promise<T>) => {
		try {
			return { ok: true as const, value: await fn() };
		} catch (e) {
			return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
		}
	};
	return [
		defineTool({
			name: "nix_option_search",
			label: "Nix-Option suchen",
			description:
				"Sucht NixOS-/Home-Manager-Optionen (mcp-nixos, Fallback lokal). Optionsnamen nie raten – erst suchen, dann mit nix_option_info bestätigen.",
			promptSnippet: "nix_option_search: NixOS/Home-Manager-Optionen suchen",
			parameters: Type.Object({ query: Type.String() }),
			async execute(_id, p) {
				const r = await wrap(() => d.knowledge.searchOptions(p.query));
				if (!r.ok) return errorResult(`Wissensquelle nicht erreichbar: ${r.error}`);
				return textResult(r.value.length ? json(r.value.slice(0, 25)) : "Keine Optionen gefunden.", r.value);
			},
		}),
		defineTool({
			name: "nix_option_info",
			label: "Nix-Option prüfen",
			description:
				"Liefert exakten Namen, Typ, Beschreibung einer Option und markiert sie als verifiziert (Voraussetzung für config_patch mit diesem Optionsnamen).",
			parameters: Type.Object({
				name: Type.String({ description: "Voller Optionsname, z.B. hardware.bluetooth.enable" }),
			}),
			async execute(_id, p) {
				const r = await wrap(() => d.knowledge.optionInfo(p.name));
				if (!r.ok) return errorResult(`Wissensquelle nicht erreichbar: ${r.error}`);
				if (!r.value)
					return textResult(
						`Option '${p.name}' nicht gefunden. Nicht verwenden; erst mit nix_option_search nach dem echten Namen suchen.`,
						{ found: false },
					);
				d.ledger.options.add(p.name);
				return textResult(json(r.value), r.value);
			},
		}),
		defineTool({
			name: "package_search",
			label: "Paket suchen",
			description: "Sucht Pakete in nixpkgs (mcp-nixos, Fallback nix search).",
			parameters: Type.Object({ query: Type.String() }),
			async execute(_id, p) {
				const r = await wrap(() => d.knowledge.searchPackages(p.query));
				if (!r.ok) return errorResult(`Wissensquelle nicht erreichbar: ${r.error}`);
				return textResult(r.value.length ? json(r.value.slice(0, 25)) : "Keine Pakete gefunden.", r.value);
			},
		}),
		defineTool({
			name: "package_info",
			label: "Paket prüfen",
			description: "Bestätigt ein nixpkgs-Attribut und markiert es als verifiziert.",
			parameters: Type.Object({ name: Type.String({ description: "nixpkgs-Attribut, z.B. firefox" }) }),
			async execute(_id, p) {
				const r = await wrap(() => d.knowledge.packageInfo(p.name));
				if (!r.ok) return errorResult(`Wissensquelle nicht erreichbar: ${r.error}`);
				if (!r.value) return textResult(`Paket '${p.name}' nicht gefunden.`, { found: false });
				d.ledger.packages.add(p.name);
				return textResult(json(r.value), r.value);
			},
		}),
	];
}
