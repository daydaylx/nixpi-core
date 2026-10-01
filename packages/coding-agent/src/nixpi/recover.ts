import { existsSync } from "node:fs";
import type { Runner } from "./exec/runner.ts";
import { ChangeStore } from "./history/store.ts";
import { currentGeneration, healthcheck, listGenerations } from "./nix/ops.ts";
import type { NixpiPaths } from "./paths.ts";

export interface RecoverReport {
	generations: ReturnType<typeof listGenerations>;
	currentGeneration?: number;
	gitStatus: string[];
	lastCommit?: string;
	lastSuccessful?: { commit?: string; generation?: number; intent: string };
	health?: Awaited<ReturnType<typeof healthcheck>>;
	recentErrors: string[];
	actions: string[];
}

/** Everything `nixpi recover` shows. No LLM, no provider, no network. */
export async function recoverReport(runner: Runner, paths: NixpiPaths, profilesDir?: string): Promise<RecoverReport> {
	let generations: ReturnType<typeof listGenerations> = [];
	try {
		generations = listGenerations(profilesDir);
	} catch {
		/* not NixOS */
	}
	const repoOk = existsSync(paths.repo);
	const st = repoOk ? await runner.run("git", ["status", "--porcelain=v1", "-b"], { cwd: paths.repo }) : undefined;
	const log = repoOk ? await runner.run("git", ["log", "-1", "--format=%h %cs %s"], { cwd: paths.repo }) : undefined;
	const store = new ChangeStore(paths.stateDir);
	const good = store
		.list(200)
		.find((c) => c.status === "committed" && c.healthResult?.ok !== false && c.applyResult?.exitCode === 0);
	const health = await healthcheck(runner).catch(() => undefined);
	const j = await runner
		.run("journalctl", ["--no-pager", "-b", "-p", "3", "-n", "20", "-o", "short-iso"], { timeoutMs: 15000 })
		.catch(() => undefined);
	return {
		generations: generations.slice(-10),
		currentGeneration: currentGeneration(profilesDir),
		gitStatus: st?.stdout.trim().split("\n").filter(Boolean) ?? [],
		lastCommit: log?.stdout.trim(),
		lastSuccessful: good
			? { commit: good.gitCommit, generation: good.generation, intent: good.userIntent }
			: undefined,
		health,
		recentErrors: j?.stdout.trim().split("\n").filter(Boolean) ?? [],
		actions: [
			"Rollback letzte Generation:  sudo nixos-rebuild switch --rollback",
			"Auf Generation N:            sudo nix-env -p /nix/var/nix/profiles/system --switch-generation N && sudo /nix/var/nix/profiles/system/bin/switch-to-configuration switch",
			`Config verwerfen (ungeprüft!): git -C ${paths.repo} restore .   |   letzter Commit zurück: git -C ${paths.repo} revert <commit>`,
			"Boot: im Bootmenü eine ältere Generation wählen",
		],
	};
}

export function formatRecover(r: RecoverReport): string {
	const L: string[] = ["NixPi Recovery (ohne LLM)", ""];
	L.push(`Aktuelle Generation: ${r.currentGeneration ?? "unbekannt (kein NixOS?)"}`);
	L.push("Generationen:", ...r.generations.map((g) => `  ${g.current ? "*" : " "} ${g.number}  ${g.date}`));
	L.push("", `Git: ${r.lastCommit ?? "kein Repo"}`, ...r.gitStatus.map((l) => `  ${l}`));
	if (r.lastSuccessful)
		L.push(
			"",
			`Letzter erfolgreicher Stand: Commit ${r.lastSuccessful.commit ?? "?"}, Generation ${r.lastSuccessful.generation ?? "?"} – ${r.lastSuccessful.intent}`,
		);
	if (r.health)
		L.push(
			"",
			`Healthcheck: ${r.health.ok ? "OK" : "AUFFÄLLIG"} (${r.health.state})`,
			...(r.health.error ? [`  Fehler: ${r.health.error}`] : []),
			...r.health.failedUnits.map((u) => `  fehlgeschlagen: ${u}`),
		);
	if (r.recentErrors.length) L.push("", "Letzte Fehler im Journal:", ...r.recentErrors.map((l) => `  ${l}`));
	L.push("", "Aktionen (manuell, NixPi nicht nötig):", ...r.actions.map((a) => `  ${a}`));
	return L.join("\n");
}
