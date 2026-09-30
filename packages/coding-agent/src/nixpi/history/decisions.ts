import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findSecretInContent, GuardError, resolveRepoPath } from "../policy/guard.ts";

export interface DecisionInput {
	title: string;
	goal: string;
	initial: string;
	decision: string;
	why: string;
	rejected: string;
	modules: string[];
	effects: string;
	rollback: string;
	date?: string;
	generation?: number;
	gitCommit?: string;
}

export const slugify = (s: string): string =>
	s
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/ß/g, "ss")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 50) || "entscheidung";

export function renderDecision(d: DecisionInput): string {
	return `# ${d.title}

Datum: ${d.date ?? new Date().toISOString().slice(0, 10)}
Generation: ${d.generation ?? ""}
Git Commit: ${d.gitCommit ?? ""}

## Ziel
${d.goal}

## Ausgangslage
${d.initial}

## Entscheidung
${d.decision}

## Warum
${d.why}

## Verworfene Alternativen
${d.rejected}

## Betroffene Module
${d.modules.map((m) => `- ${m}`).join("\n")}

## Auswirkungen
${d.effects}

## Rollback
${d.rollback}
`;
}

/** Writes `decisions/YYYY-MM-DD-<slug>.md` inside the config repo. Refuses secrets. Never overwrites. */
export function writeDecision(repo: string, d: DecisionInput): string {
	const body = renderDecision(d);
	const secret = findSecretInContent(body);
	if (secret) throw new GuardError(`Decision Record enthält ein Secret (${secret})`);
	const date = d.date ?? new Date().toISOString().slice(0, 10);
	const rel = `decisions/${date}-${slugify(d.title)}.md`;
	mkdirSync(join(repo, "decisions"), { recursive: true });
	const abs = resolveRepoPath(repo, rel);
	if (existsSync(abs)) throw new GuardError(`Decision Record existiert bereits: ${rel}`);
	writeFileSync(abs, body);
	return rel;
}

/** Plain text search over existing decision records (for "Warum ist das so?"). */
export function searchDecisions(repo: string, query: string): Array<{ file: string; excerpt: string }> {
	const dir = join(repo, "decisions");
	if (!existsSync(dir)) return [];
	const terms = query
		.toLowerCase()
		.split(/\s+/)
		.filter((t) => t.length > 1);
	const hits: Array<{ file: string; excerpt: string; score: number }> = [];
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
		const text = readFileSync(join(dir, f), "utf-8");
		const low = text.toLowerCase();
		const score = terms.filter((t) => low.includes(t)).length;
		if (score > 0) hits.push({ file: `decisions/${f}`, excerpt: text.slice(0, 600), score });
	}
	return hits
		.sort((a, b) => b.score - a.score)
		.slice(0, 5)
		.map(({ file, excerpt }) => ({ file, excerpt }));
}
