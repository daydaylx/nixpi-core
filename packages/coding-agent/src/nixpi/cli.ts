import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { detectSystem } from "./bootstrap/detect.ts";
import { writeRepo } from "./bootstrap/generate.ts";
import { SystemRunner } from "./exec/runner.ts";
import { nixBuild } from "./nix/ops.ts";
import { resolveNixpiPaths } from "./paths.ts";
import { formatRecover, recoverReport } from "./recover.ts";
import { formatVersion, readVersion } from "./version.ts";

/** NixPi never phones home by default (upstream update check, telemetry). */
export function applyPrivacyDefaults(env: NodeJS.ProcessEnv = process.env): void {
	env.PI_SKIP_VERSION_CHECK ??= "1";
	env.PI_TELEMETRY ??= "0";
}

const HELP = `nixpi – NixOS-Systemagent

  nixpi                  interaktive Sitzung (CHANGE/PLAN)
  nixpi recover          Recovery-Bericht ohne LLM (Generationen, Git, Health, Logs)
  nixpi bootstrap        verwaltetes Config-Repo aus /etc/nixos erzeugen [--nixpi-flake <ref>] [--yes] [--build]
  nixpi version          NixPi- und Pi-Upstream-Version
`;

async function confirm(q: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return /^(j|ja|y|yes)$/i.test((await rl.question(`${q} [j/N] `)).trim());
	} finally {
		rl.close();
	}
}

/** Returns true if a NixPi subcommand handled the invocation. */
export async function runNixpiCli(args: string[]): Promise<boolean> {
	applyPrivacyDefaults();
	const cmd = args[0];
	const paths = resolveNixpiPaths();
	if (cmd === "version" || args.includes("--version") || args.includes("-v")) {
		console.log(formatVersion(readVersion()));
		return true;
	}
	if (cmd === "recover") {
		console.log(formatRecover(await recoverReport(new SystemRunner(), paths)));
		return true;
	}
	if (cmd === "bootstrap") {
		const yes = args.includes("--yes");
		const i = args.indexOf("--nixpi-flake");
		const nixpiFlake = i >= 0 ? args[i + 1] : undefined;
		const sys = detectSystem({ configRepo: paths.repo });
		console.log(
			`Erkannt: ${sys.isNixos ? "NixOS" : "KEIN NixOS"} ${sys.versionId ?? ""}, Host ${sys.host}, Benutzer ${sys.user}, ${sys.system}, stateVersion ${sys.stateVersion ?? "?"}`,
		);
		if (!sys.isNixos) return fail("Kein NixOS erkannt – Bootstrap abgebrochen.");
		if (sys.configExists) return fail(`${paths.repo} existiert bereits – nichts überschrieben.`);
		if (!yes && !(await confirm(`Frisches NixOS erkannt. Verwaltetes Repo in ${paths.repo} anlegen?`)))
			return fail("Abgebrochen.");
		try {
			const r = writeRepo({ repo: paths.repo, sys, nixpiFlake });
			console.log(
				`Repo angelegt (${r.written.length} Dateien, ${r.committed ? "committet" : "nur gestaged – git user.name/email setzen und committen"}).`,
			);
		} catch (e) {
			return fail(e instanceof Error ? e.message : String(e));
		}
		if (args.includes("--build")) {
			console.log("Baue …");
			const b = await nixBuild(new SystemRunner(), paths.repo, paths.host);
			if (!b.success) return fail(`Build fehlgeschlagen:\n${b.errors.join("\n")}`);
			console.log(`Build ok: ${b.outPath}`);
			if (await confirm("Jetzt aktivieren (nh os switch / nixos-rebuild switch)?")) {
				const hasNh = spawnSync("nh", ["--version"], { stdio: "ignore" }).status === 0;
				const [c, a] = hasNh
					? ["nh", ["os", "switch", paths.repo, "--hostname", paths.host]]
					: ["sudo", ["nixos-rebuild", "switch", "--flake", `${paths.repo}#${paths.host}`]];
				process.exitCode = spawnSync(c!, a as string[], { stdio: "inherit" }).status ?? 1;
			}
		} else
			console.log(
				`Nächste Schritte: nixpi bootstrap --build  oder  nh os build ${paths.repo} --hostname ${paths.host}`,
			);
		return true;
	}
	if (cmd === "help" || args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return true;
	}
	return false;
}

function fail(msg: string): true {
	console.error(msg);
	process.exitCode = 1;
	return true;
}
