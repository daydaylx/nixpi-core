import { createHash } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { Type } from "typebox";
import type { ExtensionContext } from "../../core/extensions/types.ts";
import { runWithTerminal } from "../exec/interactive.ts";
import { type DecisionInput, writeDecision } from "../history/decisions.ts";
import { commitMessage } from "../history/store.ts";
import {
	currentGeneration,
	healthcheck,
	listGenerations,
	nixBuild,
	nixCheck,
	nixEval,
	repoFingerprint,
	resolveHost,
	stageRequired,
} from "../nix/ops.ts";
import { findSecretInContent, GuardError, MAX_FILE_BYTES, resolveRepoPath } from "../policy/guard.ts";
import { classifyRisk, gateApply, maxRisk } from "../policy/risk.ts";
import { type AnyTool, clip, defineTool, errorResult, json, type NixpiDeps, textResult } from "./deps.ts";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function mutateTools(d: NixpiDeps): AnyTool[] {
	const repo = d.paths.repo;

	/** Every mutation goes through this: attaches the edit to the current ChangeSet and invalidates builds. */
	const touch = (
		file: string,
		intent: string | undefined,
		riskText: string,
		options: string[],
		packages: string[],
	) => {
		let id = d.work.currentChangeId;
		const existing = id ? d.store.get(id) : undefined;
		const risk = maxRisk(existing?.risk ?? "LOW", classifyRisk([file], riskText));
		if (!existing) {
			const cs = d.store.create({
				userIntent: intent?.trim() || "Änderung (ohne Intent)",
				risk,
				files: [file],
				verifiedOptions: options,
				verifiedPackages: packages,
				planReference: d.getState().plan?.goal,
			});
			d.work.currentChangeId = cs.id;
			id = cs.id;
		} else {
			d.store.update(existing.id, {
				risk,
				status: "prepared",
				files: [...new Set([...existing.files, file])],
				verifiedOptions: [...new Set([...existing.verifiedOptions, ...options])],
				verifiedPackages: [...new Set([...existing.verifiedPackages, ...packages])],
				buildResult: undefined,
				applyResult: undefined,
			});
		}
		d.work.lastBuild = undefined;
		return { id: id!, risk };
	};

	const requireChange = () => {
		if (d.getState().mode !== "CHANGE") throw new GuardError("Mutation ist nur im CHANGE-Modus erlaubt.");
	};
	const unverified = (options: string[], packages: string[]) => [
		...options.filter((o) => !d.ledger.options.has(o)).map((o) => `Option '${o}'`),
		...packages.filter((p) => !d.ledger.packages.has(p)).map((p) => `Paket '${p}'`),
	];
	const patchLog = (entry: Record<string, unknown>) => {
		mkdirSync(d.paths.stateDir, { recursive: true });
		appendFileSync(
			join(d.paths.stateDir, "patches.log"),
			`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
			{ mode: 0o600 },
		);
	};
	const atomicWrite = (abs: string, content: string, mode?: number) => {
		const tmp = `${abs}.nixpi-${process.pid}.tmp`;
		writeFileSync(tmp, content);
		if (mode !== undefined) chmodSync(tmp, mode);
		renameSync(tmp, abs);
	};
	const checkContent = (content: string, rel: string) => {
		if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new GuardError("Ergebnis zu groß");
		const s = findSecretInContent(content);
		if (s) throw new GuardError(`Inhalt wirkt wie ein Secret (${s}). Secrets gehören nicht ins Repo/den Nix Store.`);
		if (
			rel.endsWith(".nix") &&
			(content.match(/\{/g)?.length ?? 0) !== (content.match(/\}/g)?.length ?? 0) &&
			!/''|"/.test(content)
		)
			throw new GuardError("Klammern in der Nix-Datei unausgeglichen");
	};

	const optionsSchema = Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Alle NixOS/Home-Manager-Optionsnamen, die diese Änderung setzt – müssen vorher via nix_option_info verifiziert sein.",
		}),
	);
	const packagesSchema = Type.Optional(
		Type.Array(Type.String(), {
			description: "nixpkgs-Attribute, die hinzugefügt werden – vorher via package_info verifiziert.",
		}),
	);

	const configPatch = defineTool({
		name: "config_patch",
		label: "Config ändern",
		description:
			"Ersetzt genau eine Stelle (old_text kommt exakt einmal vor) in einer Datei des Config-Repos. Braucht den sha256 aus config_read (Precondition). Nur Repo, atomar, Secret-Guard, Patch-Log. Optionen/Pakete müssen verifiziert sein.",
		promptSnippet: "config_patch: gezielte Änderung im Config-Repo",
		parameters: Type.Object({
			path: Type.String(),
			expected_sha256: Type.String({ description: "sha256 des aktuellen Dateiinhalts aus config_read" }),
			old_text: Type.String(),
			new_text: Type.String(),
			intent: Type.Optional(Type.String({ description: "Nutzerwunsch in einem Satz (für Verlauf und Commit)" })),
			options: optionsSchema,
			packages: packagesSchema,
		}),
		async execute(_id, p) {
			try {
				requireChange();
				const abs = resolveRepoPath(repo, p.path);
				const current = readFileSync(abs, "utf-8");
				if (sha256(current) !== p.expected_sha256)
					return errorResult("Datei hat sich geändert (sha256 passt nicht). Erneut mit config_read lesen.");
				const count = p.old_text === "" ? 0 : current.split(p.old_text).length - 1;
				if (count !== 1) return errorResult(`old_text muss genau einmal vorkommen (gefunden: ${count}).`);
				const bad = unverified(p.options ?? [], p.packages ?? []);
				if (bad.length)
					return errorResult(`Nicht verifiziert: ${bad.join(", ")}. Erst nix_option_info/package_info aufrufen.`);
				const next = current.replace(p.old_text, () => p.new_text);
				checkContent(next, p.path);
				atomicWrite(abs, next, statSync(abs).mode & 0o777);
				const t = touch(p.path, p.intent, `${p.old_text}\n${p.new_text}`, p.options ?? [], p.packages ?? []);
				patchLog({
					file: p.path,
					change: t.id,
					before: sha256(current),
					after: sha256(next),
					old_text: p.old_text,
					new_text: p.new_text,
				});
				return textResult(
					`Gepatcht: ${p.path} (ChangeSet ${t.id}, Risiko ${t.risk}). Neuer sha256: ${sha256(next)}. Nächster Schritt: nix_build.`,
					{ change: t.id, risk: t.risk },
				);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	const configCreate = defineTool({
		name: "config_create_module",
		label: "Modul anlegen",
		description:
			"Legt eine neue .nix-Datei im Config-Repo an (existiert noch nicht). Muss danach in einem bestehenden Modul importiert werden (config_patch).",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
			intent: Type.Optional(Type.String()),
			options: optionsSchema,
			packages: packagesSchema,
		}),
		async execute(_id, p) {
			try {
				requireChange();
				if (!p.path.endsWith(".nix")) return errorResult("Nur .nix-Dateien.");
				const abs = resolveRepoPath(repo, p.path);
				if (existsSync(abs)) return errorResult("Datei existiert bereits – config_patch verwenden.");
				const bad = unverified(p.options ?? [], p.packages ?? []);
				if (bad.length) return errorResult(`Nicht verifiziert: ${bad.join(", ")}.`);
				checkContent(p.content, p.path);
				mkdirSync(dirname(abs), { recursive: true });
				atomicWrite(abs, p.content);
				const t = touch(p.path, p.intent, p.content, p.options ?? [], p.packages ?? []);
				patchLog({ file: p.path, change: t.id, created: true, after: sha256(p.content) });
				return textResult(
					`Angelegt: ${p.path} (ChangeSet ${t.id}, Risiko ${t.risk}). sha256: ${sha256(p.content)}`,
					{ change: t.id },
				);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	const gitStage = defineTool({
		name: "git_stage_required",
		label: "Neue Dateien für Flake sichtbar machen",
		description:
			"Markiert neue (nicht-geheime) Dateien per `git add -N`, damit der Flake-Build sie sieht. nix_build macht das automatisch.",
		parameters: Type.Object({}),
		async execute() {
			try {
				requireChange();
				const r = await stageRequired(d.runner, repo);
				return textResult(json(r), r);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	const buildOutput = (r: Awaited<ReturnType<typeof nixEval>>) => ({
		text: json({
			success: r.success,
			derivation: r.outPath,
			warnings: r.warnings.slice(0, 10),
			errors: r.errors.slice(0, 10),
			affected_units: r.affectedUnits,
			timed_out: r.timedOut,
		}),
	});

	const nixEvalTool = defineTool({
		name: "nix_eval",
		label: "Evaluieren",
		description: "Nur Evaluation des Zielhosts (kein Build). Optional anderer Flake-Host.",
		parameters: Type.Object({
			host: Type.Optional(
				Type.String({
					description: "Anderer Flake-Host (nur bauen/evaluieren; angewendet wird immer nur der lokale Host)",
				}),
			),
		}),
		async execute(_id, p) {
			try {
				requireChange();
				await stageRequired(d.runner, repo);
				const host = await resolveHost(d.runner, repo, d.paths.host, p.host);
				const r = await nixEval(d.runner, repo, host);
				return textResult(buildOutput(r).text, r);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});
	const nixCheckTool = defineTool({
		name: "nix_check",
		label: "Flake prüfen",
		description: "`nix flake check --no-build`.",
		parameters: Type.Object({}),
		async execute() {
			try {
				requireChange();
				await stageRequired(d.runner, repo);
				const r = await nixCheck(d.runner, repo);
				return textResult(buildOutput(r).text, r);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});
	const nixBuildTool = defineTool({
		name: "nix_build",
		label: "Bauen",
		description:
			"Baut den Zielhost (ohne Aktivierung, ohne Root). Voraussetzung für nix_test/nix_switch. Liefert strukturierte Fehler.",
		promptSnippet: "nix_build: Zielhost bauen (vor jedem Apply)",
		parameters: Type.Object({
			host: Type.Optional(
				Type.String({
					description: "Anderer Flake-Host (nur bauen/evaluieren; angewendet wird immer nur der lokale Host)",
				}),
			),
		}),
		async execute(_id, p, signal, onUpdate) {
			try {
				requireChange();
				const host = await resolveHost(d.runner, repo, d.paths.host, p.host);
				let last = 0;
				const r = await nixBuild(d.runner, repo, host, {
					signal,
					onProgress: (line) => {
						const now = Date.now();
						if (now - last < 1000) return;
						last = now;
						onUpdate?.({ content: [{ type: "text", text: `Build (${host}): ${line}` }], details: undefined });
					},
				});
				const fp = await repoFingerprint(d.runner, repo);
				const id = d.work.currentChangeId;
				if (r.success && r.outPath && id) {
					d.work.lastBuild = { changeId: id, fingerprint: fp, outPath: r.outPath, host };
					d.store.update(id, {
						host,
						status: "built",
						buildResult: { success: true, outPath: r.outPath, fingerprint: fp },
					});
				} else {
					d.work.lastBuild = undefined;
					if (id) d.store.update(id, { status: "failed", buildResult: { success: false } });
				}
				return textResult(buildOutput(r).text, r);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	/** Shared implementation of nix_test / nix_switch. */
	const apply = async (kind: "test" | "switch", ctx: ExtensionContext) => {
		requireChange();
		const id = d.work.currentChangeId;
		const cs = id ? d.store.get(id) : undefined;
		if (!cs) return errorResult("Kein aktives ChangeSet – es gibt nichts anzuwenden.");
		const fp = await repoFingerprint(d.runner, repo);
		if (d.work.lastBuild && d.work.lastBuild.host !== d.paths.host)
			return errorResult(
				`Letzter Build war für Host '${d.work.lastBuild.host}'. Angewendet wird nur der lokale Host '${d.paths.host}' – dafür erst nix_build ohne host.`,
			);
		const built = d.work.lastBuild?.changeId === cs.id && d.work.lastBuild.fingerprint === fp;
		const planApproved = d.getState().planApproved;
		const pre = gateApply({ risk: cs.risk, buildSucceeded: built, planApproved, userApproved: true });
		if (!pre.ok) return errorResult(pre.reason);
		if (d.work.webTainted && ctx.mode !== "tui")
			return errorResult("Web-Inhalte im Kontext: Apply braucht eine interaktive Bestätigung.");
		if (ctx.mode !== "tui")
			return errorResult("Apply ist nur interaktiv (TUI) möglich: sudo-Passwort und Freigabe nötig.");
		const diff = await d.runner.run("git", ["diff", "HEAD", "--stat", "--no-color"], { cwd: repo });
		const summary = [
			`Änderung: ${cs.userIntent}`,
			`Risiko: ${cs.risk}`,
			`Dateien: ${cs.files.join(", ")}`,
			"",
			diff.stdout.trim(),
			"",
			kind === "switch"
				? "Aktiviert das System und macht es zum Standard-Boot-Eintrag."
				: "Aktiviert temporär (kein Boot-Eintrag).",
		].join("\n");
		const ok = await ctx.ui.confirm(`${kind === "switch" ? "Switch" : "Test"} anwenden?`, summary);
		if (!ok) return textResult("Vom Nutzer abgebrochen. Nichts wurde angewendet.", { cancelled: true });
		const hasNh = (await d.runner.run("nh", ["--version"])).code === 0;
		const [cmd, args] = hasNh
			? (["nh", ["os", kind, repo, "--hostname", d.paths.host]] as const)
			: (["sudo", ["nixos-rebuild", kind, "--flake", `${repo}#${d.paths.host}`]] as const);
		const code = await runWithTerminal(ctx, cmd, [...args], repo);
		const at = new Date().toISOString();
		d.store.update(cs.id, {
			applyResult: { kind, exitCode: code ?? null, at },
			status: code === 0 ? "applied" : "failed",
		});
		if (code !== 0)
			return errorResult(
				`${kind} fehlgeschlagen (Exit ${code}). Der tatsächliche Systemzustand kann unklar sein; mit nixpi recover und journal_read/generation_list prüfen.`,
			);
		const generation = currentGeneration();
		const health = await healthcheck(d.runner);
		const confirmed = generation !== undefined && health.ok;
		d.store.update(cs.id, { generation, healthResult: health, status: confirmed ? "applied" : "failed" });
		if (!confirmed)
			return errorResult(
				`${kind} wurde vom System mit Exit 0 beendet, aber Aktivierung nicht bestätigt (Generation: ${generation ?? "unbekannt"}, Healthcheck: ${health.ok ? "OK" : (health.error ?? `${health.state}, ${health.failedUnits.length} fehlgeschlagene Units`)}). Nicht als erfolgreich verbucht; Zustand manuell prüfen und ggf. nixpi recover verwenden.`,
			);
		return textResult(
			json({
				applied: kind,
				generation,
				health,
				hint: "Gesund. Nächster Schritt: git_commit.",
			}),
			{ generation, health },
		);
	};

	const nixTest = defineTool({
		name: "nix_test",
		label: "Temporär aktivieren",
		description:
			"Temporäre Aktivierung (nh os test). Nur nach erfolgreichem Build; fragt den Nutzer und das sudo-Passwort selbst ab.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_id, _p, _s, _u, ctx) {
			try {
				return await apply("test", ctx);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});
	const nixSwitch = defineTool({
		name: "nix_switch",
		label: "Anwenden",
		description:
			"Privilegierter Apply-Schritt (nh os switch). Vorbedingungen: erfolgreicher Build des aktuellen Stands, Risk-Gate (HIGH nur nach ausgeführtem PLAN), Nutzerfreigabe. Das sudo-Passwort fragt das System sichtbar ab.",
		parameters: Type.Object({}),
		executionMode: "sequential",
		async execute(_id, _p, _s, _u, ctx) {
			try {
				return await apply("switch", ctx);
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	const rollback = defineTool({
		name: "generation_rollback",
		label: "Rollback",
		description:
			"Rollt auf eine existierende, bekannte Generation zurück (Standard: die vorherige). Fragt den Nutzer; sudo-Passwort sichtbar.",
		parameters: Type.Object({ generation: Type.Optional(Type.Number()) }),
		executionMode: "sequential",
		async execute(_id, p, _s, _u, ctx) {
			try {
				requireChange();
				const gens = listGenerations();
				const cur = gens.find((g) => g.current);
				const target =
					p.generation !== undefined
						? gens.find((g) => g.number === p.generation)
						: [...gens].reverse().find((g) => !g.current && (!cur || g.number < cur.number));
				if (!target)
					return errorResult(`Generation nicht bekannt. Bekannt: ${gens.map((g) => g.number).join(", ")}`);
				if (target.current) return errorResult("Das ist bereits die aktuelle Generation.");
				if (ctx.mode !== "tui") return errorResult("Rollback braucht interaktive Bestätigung (TUI).");
				const ok = await ctx.ui.confirm("Rollback", `Zurück auf Generation ${target.number} (${target.date})?`);
				if (!ok) return textResult("Vom Nutzer abgebrochen.", { cancelled: true });
				const c1 = await runWithTerminal(
					ctx,
					"sudo",
					["nix-env", "-p", "/nix/var/nix/profiles/system", "--switch-generation", String(target.number)],
					repo,
				);
				if (c1 !== 0) return errorResult(`switch-generation fehlgeschlagen (Exit ${c1}).`);
				const c2 = await runWithTerminal(
					ctx,
					"sudo",
					["/nix/var/nix/profiles/system/bin/switch-to-configuration", "switch"],
					repo,
				);
				if (c2 !== 0)
					return errorResult(`Aktivierung fehlgeschlagen (Exit ${c2}); Profil steht auf ${target.number}.`);
				const actual = currentGeneration();
				const health = await healthcheck(d.runner);
				if (actual !== target.number || !health.ok)
					return errorResult(
						`Rollback-Befehl beendet, aber Zustand nicht bestätigt (Generation: ${actual ?? "unbekannt"}, Healthcheck: ${health.ok ? "OK" : (health.error ?? health.state)}). nixpi recover ausführen.`,
					);
				const id = d.work.currentChangeId ?? d.store.latest()?.id;
				if (id) d.store.update(id, { status: "rolled_back", generation: actual, healthResult: health });
				return textResult(json({ rolledBackTo: actual, health }));
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	const gitCommit = defineTool({
		name: "git_commit",
		label: "Committen",
		description:
			"Committet die Dateien des aktuellen ChangeSets. Die Commit-Nachricht wird aus dem gespeicherten Intent erzeugt (kein freier Text). Nur nach erfolgreichem Build des aktuellen Stands.",
		parameters: Type.Object({}),
		async execute(_id, _p, _s, _u, ctx) {
			try {
				requireChange();
				const cs = d.work.currentChangeId ? d.store.get(d.work.currentChangeId) : undefined;
				if (!cs) return errorResult("Kein aktives ChangeSet.");
				const fp = await repoFingerprint(d.runner, repo);
				if (!(d.work.lastBuild?.changeId === cs.id && d.work.lastBuild.fingerprint === fp))
					return errorResult("Kein erfolgreicher Build für den aktuellen Stand – erst nix_build.");
				if (d.work.webTainted) {
					if (
						ctx.mode !== "tui" ||
						!(await ctx.ui.confirm(
							"Commit",
							`Web-Inhalte waren im Kontext. Commit für »${cs.userIntent}« freigeben?`,
						))
					)
						return errorResult("Commit nicht freigegeben (Web-Inhalte im Kontext).");
				}
				for (const f of cs.files) resolveRepoPath(repo, f);
				const add = await d.runner.run("git", ["add", "--", ...cs.files], { cwd: repo });
				if (add.code !== 0) return errorResult(add.stderr);
				const message = commitMessage({ ...cs, generation: cs.generation ?? currentGeneration() });
				const c = await d.runner.run("git", ["commit", "-m", message, "--", ...cs.files], { cwd: repo });
				if (c.code !== 0) return errorResult(clip(c.stderr || c.stdout, 2000));
				const sha = (await d.runner.run("git", ["rev-parse", "--short", "HEAD"], { cwd: repo })).stdout.trim();
				d.store.update(cs.id, {
					gitCommit: sha,
					status: "committed",
					generation: cs.generation ?? currentGeneration(),
				});
				d.work.currentChangeId = undefined;
				d.work.lastBuild = undefined;
				return textResult(`Commit ${sha}\n${message}`, { commit: sha });
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	const decisionWrite = defineTool({
		name: "decision_write",
		label: "Decision Record",
		description:
			"Schreibt decisions/YYYY-MM-DD-<thema>.md nach erfolgreicher Ausführung eines größeren Plans. Enthält Ziel, Entscheidung, Gründe, verworfene Alternativen, Commit und Generation. Keine Secrets.",
		parameters: Type.Object({
			title: Type.String(),
			goal: Type.String(),
			initial: Type.String(),
			decision: Type.String(),
			why: Type.String(),
			rejected: Type.String(),
			modules: Type.Array(Type.String()),
			effects: Type.String(),
			rollback: Type.String(),
		}),
		async execute(_id, p) {
			try {
				requireChange();
				const last = d.store.list(1)[0];
				const input: DecisionInput = { ...p, gitCommit: last?.gitCommit, generation: last?.generation };
				const rel = writeDecision(repo, input);
				if (last) d.store.update(last.id, { decisionRecord: rel });
				return textResult(`Geschrieben: ${rel}. Hinweis: Datei muss committet werden (neues ChangeSet/Commit).`, {
					path: rel,
				});
			} catch (e) {
				return errorResult(msg(e));
			}
		},
	});

	return [
		configPatch,
		configCreate,
		gitStage,
		nixEvalTool,
		nixCheckTool,
		nixBuildTool,
		nixTest,
		nixSwitch,
		rollback,
		gitCommit,
		decisionWrite,
	];
}
