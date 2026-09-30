import { readdirSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Runner } from "../exec/runner.ts";
import { isSecretPath } from "../policy/guard.ts";

export const SYSTEM_PROFILE_DIR = "/nix/var/nix/profiles";

export interface BuildResult {
	success: boolean;
	outPath?: string;
	warnings: string[];
	errors: string[];
	affectedUnits: string[];
	timedOut?: boolean;
}

/** Pulls error/warning lines out of nix stderr. Keeps the raw tail if nothing matches. */
export function parseNixOutput(stderr: string): Pick<BuildResult, "warnings" | "errors" | "affectedUnits"> {
	const errors: string[] = [];
	const warnings: string[] = [];
	const units = new Set<string>();
	const lines = stderr.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (/^\s*error:/.test(l)) {
			// collect the error plus the following indented context (max 6 lines)
			const ctx = [l.trim()];
			for (let j = i + 1; j < Math.min(lines.length, i + 7); j++) {
				if (/^\s*(error|warning):/.test(lines[j]!)) break;
				if (lines[j]!.trim()) ctx.push(lines[j]!.trim());
			}
			errors.push(ctx.join(" | "));
		} else if (/^\s*(warning|evaluation warning):/.test(l)) warnings.push(l.trim());
		const u = l.match(/unit[s]?\s+['"`]?([\w@.-]+\.(?:service|socket|timer|mount|target))/);
		if (u?.[1]) units.add(u[1]);
	}
	if (errors.length === 0 && stderr.trim()) {
		const tail = lines.filter((l) => l.trim()).slice(-8);
		if (/(fail|cannot|undefined|infinite recursion|syntax)/i.test(stderr)) errors.push(tail.join(" | "));
	}
	return { errors, warnings, affectedUnits: [...units] };
}

export async function listUntracked(runner: Runner, repo: string): Promise<string[]> {
	const r = await runner.run("git", ["ls-files", "--others", "--exclude-standard", "-z"], { cwd: repo });
	if (r.code !== 0) throw new Error(r.stderr || "git ls-files fehlgeschlagen");
	return r.stdout.split("\0").filter(Boolean);
}

/**
 * Flakes only see git-tracked files. Mark new (non-secret) files with intent-to-add so a build
 * sees them without staging their content. Returns the files it marked.
 */
export async function stageRequired(runner: Runner, repo: string): Promise<{ staged: string[]; skipped: string[] }> {
	const untracked = await listUntracked(runner, repo);
	const staged = untracked.filter((f) => !isSecretPath(f) && !f.startsWith(".git/"));
	const skipped = untracked.filter((f) => !staged.includes(f));
	if (staged.length > 0) {
		const r = await runner.run("git", ["add", "-N", "--", ...staged], { cwd: repo });
		if (r.code !== 0) throw new Error(r.stderr || "git add -N fehlgeschlagen");
	}
	return { staged, skipped };
}

const flakeRef = (repo: string, host: string) => `${repo}#nixosConfigurations.${host}.config.system.build.toplevel`;

export interface BuildOptions {
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Receives a short human-readable progress line (what nix is doing right now). */
	onProgress?: (line: string) => void;
}

/** `NIXPI_BUILD_TIMEOUT_MIN` (minutes, default 120). */
export function buildTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
	const m = Number(env.NIXPI_BUILD_TIMEOUT_MIN);
	return (Number.isFinite(m) && m > 0 ? m : 120) * 60_000;
}

/** Shortens nix output lines like `building '/nix/store/<hash>-foo-1.2.drv'...` to `building foo-1.2`. */
export function summarizeProgress(line: string): string {
	const l = line.trim();
	const m = l.match(
		/^(building|copying path|downloading|fetching)\s+'?(?:\/nix\/store\/[a-z0-9]{32}-)?([^'\s]+?)(?:\.drv)?'?(?:\s|\.\.\.|$)/,
	);
	return m ? `${m[1]} ${m[2]}` : l.slice(0, 120);
}

const HOST_RE = /^[A-Za-z0-9_-]+$/;

/** Hosts defined in the flake (`nixosConfigurations`). Returns undefined if nix cannot tell. */
export async function listHosts(runner: Runner, repo: string): Promise<string[] | undefined> {
	const r = await runner.run(
		"nix",
		["eval", "--json", `${repo}#nixosConfigurations`, "--apply", "builtins.attrNames"],
		{
			cwd: repo,
			timeoutMs: 120_000,
		},
	);
	if (r.code !== 0) return undefined;
	try {
		const hosts = JSON.parse(r.stdout) as string[];
		return hosts.filter((h) => HOST_RE.test(h));
	} catch {
		return undefined;
	}
}

/**
 * Resolves the host a tool call targets. No `requested` host = the configured default.
 * A different host must be a plain identifier and exist in the flake.
 */
export async function resolveHost(
	runner: Runner,
	repo: string,
	defaultHost: string,
	requested?: string,
): Promise<string> {
	if (!requested || requested === defaultHost) return defaultHost;
	if (!HOST_RE.test(requested)) throw new Error(`Ungültiger Hostname: ${requested}`);
	const hosts = await listHosts(runner, repo);
	if (!hosts) throw new Error("Hostliste des Flakes nicht lesbar – nur der Standard-Host ist erlaubt.");
	if (!hosts.includes(requested)) throw new Error(`Host '${requested}' nicht im Flake. Bekannt: ${hosts.join(", ")}`);
	return requested;
}

export async function nixEval(runner: Runner, repo: string, host: string): Promise<BuildResult> {
	const r = await runner.run("nix", ["eval", "--raw", `${flakeRef(repo, host)}.drvPath`], {
		cwd: repo,
		timeoutMs: 15 * 60_000,
	});
	return {
		success: r.code === 0,
		outPath: r.code === 0 ? r.stdout.trim() : undefined,
		...parseNixOutput(r.stderr),
		timedOut: r.timedOut,
	};
}

export async function nixCheck(runner: Runner, repo: string): Promise<BuildResult> {
	const r = await runner.run("nix", ["flake", "check", "--no-build", repo], { cwd: repo, timeoutMs: 15 * 60_000 });
	return { success: r.code === 0, ...parseNixOutput(r.stderr), timedOut: r.timedOut };
}

/** Builds the host closure without touching the running system (no sudo, no activation). */
export async function nixBuild(
	runner: Runner,
	repo: string,
	host: string,
	opts: BuildOptions = {},
): Promise<BuildResult> {
	await stageRequired(runner, repo);
	const r = await runner.run("nix", ["build", flakeRef(repo, host), "--no-link", "--print-out-paths"], {
		cwd: repo,
		timeoutMs: opts.timeoutMs ?? buildTimeoutMs(),
		signal: opts.signal,
		onLine: opts.onProgress ? (l) => opts.onProgress!(summarizeProgress(l)) : undefined,
	});
	const out = r.stdout.trim().split("\n").filter(Boolean).pop();
	return { success: r.code === 0 && !!out, outPath: out, ...parseNixOutput(r.stderr), timedOut: r.timedOut };
}

/** Hash of the flake inputs + tracked content: detects edits made after the last successful build. */
export async function repoFingerprint(runner: Runner, repo: string): Promise<string> {
	const head = await runner.run("git", ["rev-parse", "HEAD"], { cwd: repo });
	const diff = await runner.run("git", ["diff", "HEAD", "--no-ext-diff", "--binary"], { cwd: repo });
	const { createHash } = await import("node:crypto");
	return createHash("sha256").update(head.stdout).update("\0").update(diff.stdout).digest("hex");
}

export interface Generation {
	number: number;
	date: string;
	current: boolean;
}

export function parseGenerationNumber(linkTarget: string): number | undefined {
	const m = linkTarget.match(/system-(\d+)-link$/);
	return m ? Number(m[1]) : undefined;
}

export function listGenerations(profilesDir = SYSTEM_PROFILE_DIR): Generation[] {
	let current: number | undefined;
	try {
		current = parseGenerationNumber(readlinkSync(join(profilesDir, "system")));
	} catch {
		/* not NixOS */
	}
	const out: Generation[] = [];
	for (const name of readdirSync(profilesDir)) {
		const n = parseGenerationNumber(name);
		if (n === undefined) continue;
		out.push({
			number: n,
			date: statSync(join(profilesDir, name), { throwIfNoEntry: false })?.mtime.toISOString() ?? "",
			current: n === current,
		});
	}
	return out.sort((a, b) => a.number - b.number);
}

export function currentGeneration(profilesDir = SYSTEM_PROFILE_DIR): number | undefined {
	try {
		return listGenerations(profilesDir).find((g) => g.current)?.number;
	} catch {
		return undefined;
	}
}

export interface Health {
	ok: boolean;
	state: string;
	failedUnits: string[];
}

export async function healthcheck(runner: Runner): Promise<Health> {
	const st = await runner.run("systemctl", ["is-system-running"], { timeoutMs: 15000 });
	const state = st.stdout.trim() || "unknown";
	const failed = await runner.run("systemctl", ["--failed", "--no-legend", "--plain"], { timeoutMs: 15000 });
	const failedUnits = failed.stdout
		.split("\n")
		.map((l) => l.trim().split(/\s+/)[0])
		.filter((x): x is string => !!x);
	return { ok: (state === "running" || state === "degraded") && failedUnits.length === 0, state, failedUnits };
}
