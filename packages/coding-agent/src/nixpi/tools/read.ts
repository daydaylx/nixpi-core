import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { hostname, release } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { searchDecisions } from "../history/decisions.ts";
import { listGenerations } from "../nix/ops.ts";
import { isSecretPath, MAX_FILE_BYTES, readRepoFile, resolveRepoPath } from "../policy/guard.ts";
import { type AnyTool, clip, defineTool, errorResult, json, type NixpiDeps, textResult } from "./deps.ts";

const UNIT_RE = /^[A-Za-z0-9@:._-]+(\.(service|socket|timer|mount|target|path|scope|slice))?$/;

/** Walks the config repo, skipping .git, secrets and big/binary files. */
export function* walkRepo(repo: string, dir = ""): Generator<string> {
	for (const name of readdirSync(join(repo, dir))) {
		const rel = dir ? `${dir}/${name}` : name;
		if (name === ".git" || name === "result" || name === "node_modules") continue;
		const st = lstatSync(join(repo, rel));
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) yield* walkRepo(repo, rel);
		else if (!isSecretPath(rel) && st.size <= MAX_FILE_BYTES) yield rel;
	}
}

export function readTools(d: NixpiDeps): AnyTool[] {
	const run = (cmd: string, args: string[], timeoutMs = 20_000) =>
		d.runner.run(cmd, args, { cwd: d.paths.repo, timeoutMs });

	const systemSnapshot = defineTool({
		name: "system_snapshot",
		label: "System-Snapshot",
		description:
			"Strukturierter, read-only Systemzustand (Host, NixOS, Kernel, Generation, Git-Status, Netzwerk, Audio, Bluetooth, Energie, Dienste). Optional auf Bereiche einschränken.",
		promptSnippet: "system_snapshot: read-only Systemzustand",
		parameters: Type.Object({
			scope: Type.Optional(
				Type.Array(
					Type.Union(
						["os", "hardware", "network", "audio", "bluetooth", "power", "services", "nix", "config"].map((s) =>
							Type.Literal(s),
						),
					),
				),
			),
		}),
		async execute(_id, p) {
			const want = new Set<string>(p.scope ?? ["os", "nix", "config", "services"]);
			const out: Record<string, unknown> = {};
			const safe = async (key: string, fn: () => Promise<unknown> | unknown) => {
				try {
					out[key] = await fn();
				} catch (e) {
					out[key] = { error: e instanceof Error ? e.message : String(e) };
				}
			};
			if (want.has("os"))
				await safe("os", () => {
					const osr: Record<string, string> = {};
					for (const l of readFileSync("/etc/os-release", "utf-8").split("\n")) {
						const m = l.match(/^(NAME|VERSION|VERSION_ID|BUILD_ID)="?([^"]*)"?$/);
						if (m) osr[m[1]!.toLowerCase()] = m[2]!;
					}
					const gens = (() => {
						try {
							return listGenerations();
						} catch {
							return [];
						}
					})();
					return {
						host: hostname(),
						flake_host: d.paths.host,
						kernel: release(),
						...osr,
						generation: gens.find((g) => g.current)?.number,
						session: process.env.XDG_SESSION_TYPE,
						desktop: process.env.XDG_CURRENT_DESKTOP,
					};
				});
			if (want.has("nix"))
				await safe("nix", async () => ({
					version: (await run("nix", ["--version"])).stdout.trim(),
					nh: (await run("nh", ["--version"])).code === 0,
				}));
			if (want.has("config"))
				await safe("config", async () => {
					const st = await run("git", ["status", "--porcelain=v1", "-b"]);
					const log = await run("git", ["log", "-1", "--format=%h %cs %s"]);
					return {
						repo: d.paths.repo,
						exists: existsSync(d.paths.repo),
						git_status: st.stdout.trim().split("\n"),
						last_commit: log.stdout.trim(),
					};
				});
			if (want.has("hardware"))
				await safe("hardware", async () => ({
					pci: (await run("lspci", ["-nn"])).stdout
						.split("\n")
						.filter((l) => /VGA|3D|Audio|Network|Ethernet|Bluetooth/i.test(l)),
					usb: (await run("lsusb", [])).stdout.split("\n").slice(0, 30),
				}));
			if (want.has("network"))
				await safe("network", async () => (await run("ip", ["-br", "address"])).stdout.trim().split("\n"));
			if (want.has("audio"))
				await safe("audio", async () => ({
					pipewire: (await run("systemctl", ["--user", "is-active", "pipewire"])).stdout.trim(),
					wireplumber: (await run("systemctl", ["--user", "is-active", "wireplumber"])).stdout.trim(),
				}));
			if (want.has("bluetooth"))
				await safe("bluetooth", async () => ({
					service: (await run("systemctl", ["is-active", "bluetooth"])).stdout.trim(),
				}));
			if (want.has("power"))
				await safe("power", () => {
					const base = "/sys/class/power_supply";
					return existsSync(base)
						? readdirSync(base).map((n) => ({
								name: n,
								status: readSys(join(base, n, "status")),
								capacity: readSys(join(base, n, "capacity")),
							}))
						: [];
				});
			if (want.has("services"))
				await safe("services", async () => ({
					state: (await run("systemctl", ["is-system-running"])).stdout.trim(),
					failed: (await run("systemctl", ["--failed", "--no-legend", "--plain"])).stdout
						.trim()
						.split("\n")
						.filter(Boolean),
				}));
			return textResult(json(out), out);
		},
	});

	const configRead = defineTool({
		name: "config_read",
		label: "Config lesen",
		description:
			"Liest eine Datei im NixOS-Config-Repo (relativer Pfad). Liefert Inhalt und sha256 für config_patch.",
		promptSnippet: "config_read: Datei im Config-Repo lesen",
		parameters: Type.Object({
			path: Type.String({ description: "Relativer Pfad im Config-Repo, z.B. desktop/shortcuts.nix" }),
		}),
		async execute(_id, p) {
			try {
				const content = readRepoFile(d.paths.repo, p.path);
				const sha = createHash("sha256").update(content).digest("hex");
				return textResult(`sha256: ${sha}\n---\n${content}`, { path: p.path, sha256: sha });
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	});

	const configSearch = defineTool({
		name: "config_search",
		label: "Config durchsuchen",
		description:
			"Sucht (case-insensitive, Textsuche) im Config-Repo. Gibt Datei:Zeile:Text zurück, max. 60 Treffer. Auch Dateinamen.",
		parameters: Type.Object({ query: Type.String(), path_prefix: Type.Optional(Type.String()) }),
		async execute(_id, p) {
			const q = p.query.toLowerCase();
			const hits: string[] = [];
			try {
				if (p.path_prefix) resolveRepoPath(d.paths.repo, p.path_prefix);
				for (const rel of walkRepo(d.paths.repo)) {
					if (p.path_prefix && !rel.startsWith(p.path_prefix)) continue;
					if (rel.toLowerCase().includes(q)) hits.push(`${rel} (Dateiname)`);
					const lines = readFileSync(join(d.paths.repo, rel), "utf-8").split("\n");
					for (let i = 0; i < lines.length && hits.length < 60; i++)
						if (lines[i]!.toLowerCase().includes(q))
							hits.push(`${rel}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
					if (hits.length >= 60) break;
				}
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
			return textResult(hits.length ? hits.join("\n") : "Keine Treffer.", { count: hits.length });
		},
	});

	const gitStatus = defineTool({
		name: "git_status",
		label: "Git-Status",
		description: "git status des Config-Repos (read-only).",
		parameters: Type.Object({}),
		async execute() {
			const r = await run("git", ["status", "--porcelain=v1", "-b"]);
			return r.code === 0 ? textResult(r.stdout || "sauber") : errorResult(r.stderr);
		},
	});

	const gitDiff = defineTool({
		name: "git_diff",
		label: "Git-Diff",
		description: "Diff des Config-Repos gegen HEAD (read-only). Optional nur ein Pfad.",
		parameters: Type.Object({ path: Type.Optional(Type.String()), staged: Type.Optional(Type.Boolean()) }),
		async execute(_id, p) {
			try {
				const args = ["diff", "--no-ext-diff", "--no-color"];
				if (p.staged) args.push("--cached");
				else args.push("HEAD");
				if (p.path) {
					resolveRepoPath(d.paths.repo, p.path);
					args.push("--", p.path);
				}
				const r = await run("git", args);
				return r.code === 0 ? textResult(clip(r.stdout || "Kein Diff.")) : errorResult(r.stderr);
			} catch (e) {
				return errorResult(e instanceof Error ? e.message : String(e));
			}
		},
	});

	const serviceStatus = defineTool({
		name: "service_status",
		label: "Dienststatus",
		description: "systemd-Status einer Unit (read-only). system oder user.",
		parameters: Type.Object({ unit: Type.String(), user: Type.Optional(Type.Boolean()) }),
		async execute(_id, p) {
			if (!UNIT_RE.test(p.unit) || p.unit.startsWith("-")) return errorResult("Ungültiger Unit-Name");
			const r = await run("systemctl", [
				...(p.user ? ["--user"] : []),
				"status",
				"--no-pager",
				"-n",
				"0",
				"--",
				p.unit,
			]);
			return textResult(clip(r.stdout || r.stderr, 8000), { exit: r.code });
		},
	});

	const journalRead = defineTool({
		name: "journal_read",
		label: "Journal lesen",
		description: "Liest journalctl (read-only), max. 200 Zeilen. Optional Unit, Priorität (0-7), aktueller Boot.",
		parameters: Type.Object({
			unit: Type.Optional(Type.String()),
			priority: Type.Optional(Type.Number({ minimum: 0, maximum: 7 })),
			lines: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
			user: Type.Optional(Type.Boolean()),
			current_boot: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, p) {
			if (p.unit && (!UNIT_RE.test(p.unit) || p.unit.startsWith("-"))) return errorResult("Ungültiger Unit-Name");
			const args = [
				"--no-pager",
				"-o",
				"short-iso",
				"-n",
				String(Math.min(200, Math.max(1, Math.floor(p.lines ?? 50)))),
			];
			if (p.user) args.push("--user");
			if (p.unit) args.push("-u", p.unit);
			if (p.priority !== undefined) args.push("-p", String(Math.floor(p.priority)));
			if (p.current_boot ?? true) args.push("-b");
			const r = await run("journalctl", args, 30_000);
			return textResult(clip(r.stdout || r.stderr, 30_000));
		},
	});

	const generationList = defineTool({
		name: "generation_list",
		label: "Generationen",
		description: "Listet NixOS-Systemgenerationen (read-only).",
		parameters: Type.Object({}),
		async execute() {
			try {
				const g = listGenerations();
				return textResult(json(g.slice(-20)), g);
			} catch (e) {
				return errorResult(`Generationen nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
			}
		},
	});

	const historyList = defineTool({
		name: "history_list",
		label: "Änderungsverlauf",
		description:
			"Letzte NixPi-Änderungen (ChangeSets: Intent, Dateien, Commit, Generation). Optional nach Datei filtern.",
		parameters: Type.Object({ limit: Type.Optional(Type.Number()), file: Type.Optional(Type.String()) }),
		async execute(_id, p) {
			const items = p.file ? d.store.byFile(p.file) : d.store.list(Math.min(50, p.limit ?? 10));
			return textResult(items.length ? json(items) : "Keine Änderungen erfasst.", items);
		},
	});

	const decisionSearch = defineTool({
		name: "decision_search",
		label: "Entscheidungen suchen",
		description:
			"Sucht in decisions/*.md. Nutze dies vor Antworten auf 'Warum ist das so eingestellt?' – keine Begründung erfinden.",
		parameters: Type.Object({ query: Type.String() }),
		async execute(_id, p) {
			const hits = searchDecisions(d.paths.repo, p.query);
			return textResult(
				hits.length ? json(hits) : "Kein Decision Record gefunden (Git-History und aktuelle Config prüfen).",
				hits,
			);
		},
	});

	return [
		systemSnapshot,
		configRead,
		configSearch,
		gitStatus,
		gitDiff,
		serviceStatus,
		journalRead,
		generationList,
		historyList,
		decisionSearch,
	];
}

function readSys(p: string): string | undefined {
	try {
		return readFileSync(p, "utf-8").trim();
	} catch {
		return undefined;
	}
}
