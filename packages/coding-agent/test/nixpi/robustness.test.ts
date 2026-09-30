import { spawn } from "node:child_process";
import { mkdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FakeRunner, SystemRunner } from "../../src/nixpi/exec/runner.ts";
import { ChangeStore } from "../../src/nixpi/history/store.ts";
import { buildTimeoutMs, listHosts, nixBuild, resolveHost, summarizeProgress } from "../../src/nixpi/nix/ops.ts";
import { call, cleanup, gitRepo, harness, tmp } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

const runChild = (dir: string, n: number, tag: string) =>
	new Promise<number>((resolve) => {
		const c = spawn(process.execPath, [join(import.meta.dirname, "fixtures/store-writer.mjs"), dir, String(n), tag], {
			stdio: "pipe",
		});
		let err = "";
		c.stderr.on("data", (d) => {
			err += d;
		});
		c.on("close", (code) => {
			if (code !== 0) console.error(err);
			resolve(code ?? 1);
		});
	});

describe("ChangeStore under concurrency", () => {
	it("parallel processes neither lose writes nor reuse ids", async () => {
		const dir = tmp();
		dirs.push(dir);
		const codes = await Promise.all([1, 2, 3, 4, 5].map((i) => runChild(dir, 8, `p${i}`)));
		expect(codes).toEqual([0, 0, 0, 0, 0]);
		const all = new ChangeStore(dir).list(1000);
		expect(all).toHaveLength(40);
		expect(new Set(all.map((c) => c.id)).size).toBe(40);
		expect(all.every((c) => c.status === "built")).toBe(true);
	}, 60000);

	it("takes over a stale lock left by a crashed process", () => {
		const dir = tmp();
		dirs.push(dir);
		const lock = join(dir, "changesets.json.lock");
		mkdirSync(lock);
		const old = new Date(Date.now() - 60_000);
		utimesSync(lock, old, old);
		expect(new ChangeStore(dir).create({ userIntent: "x", risk: "LOW" }).id).toMatch(/^cs-/);
	});
});

describe("build progress and timeout", () => {
	it("summarizes nix output lines", () => {
		expect(summarizeProgress("building '/nix/store/abcdefghijklmnopqrstuvwxyz012345-foo-1.2.drv'...")).toBe(
			"building foo-1.2",
		);
		expect(
			summarizeProgress("copying path '/nix/store/abcdefghijklmnopqrstuvwxyz012345-bar' from 'https://cache'"),
		).toBe("copying path bar");
		expect(summarizeProgress("some other line")).toBe("some other line");
	});
	it("nixBuild streams progress and passes the configured timeout", async () => {
		const seen: string[] = [];
		const r = new FakeRunner((cmd) =>
			cmd === "nix"
				? {
						stdout: "/nix/store/x-system\n",
						stderr: "building '/nix/store/abcdefghijklmnopqrstuvwxyz012345-hello-2.0.drv'...\n",
					}
				: { stdout: "" },
		);
		const res = await nixBuild(r, "/repo", "h", { timeoutMs: 1234, onProgress: (l) => seen.push(l) });
		expect(res.success).toBe(true);
		expect(seen).toContain("building hello-2.0");
		expect(r.calls.find((c) => c.cmd === "nix")?.opts?.timeoutMs).toBe(1234);
	});
	it("timeout comes from NIXPI_BUILD_TIMEOUT_MIN with sane fallback", () => {
		expect(buildTimeoutMs({})).toBe(120 * 60_000);
		expect(buildTimeoutMs({ NIXPI_BUILD_TIMEOUT_MIN: "5" })).toBe(5 * 60_000);
		expect(buildTimeoutMs({ NIXPI_BUILD_TIMEOUT_MIN: "abc" })).toBe(120 * 60_000);
		expect(buildTimeoutMs({ NIXPI_BUILD_TIMEOUT_MIN: "-1" })).toBe(120 * 60_000);
	});
	it("SystemRunner delivers output line by line", async () => {
		const lines: string[] = [];
		const repo = gitRepo({ "a.txt": "x" });
		dirs.push(repo);
		await new SystemRunner().run("git", ["log", "--format=%s"], { cwd: repo, onLine: (l) => lines.push(l) });
		expect(lines).toEqual(["init"]);
	});
});

describe("multiple hosts", () => {
	const nixRunner = (hosts: string[]) =>
		new FakeRunner((cmd, args) => {
			if (cmd === "nix" && args[0] === "eval" && args.includes("builtins.attrNames"))
				return { stdout: JSON.stringify(hosts) };
			if (cmd === "nix" && args[0] === "build")
				return { stdout: `/nix/store/${args[1]!.split("nixosConfigurations.")[1]!.split(".")[0]}-sys\n` };
			if (cmd === "git" && args[0] === "rev-parse") return { stdout: "abc" };
			return { stdout: "" };
		});

	it("lists hosts and validates requests", async () => {
		const r = nixRunner(["laptop", "server"]);
		expect(await listHosts(r, "/repo")).toEqual(["laptop", "server"]);
		expect(await resolveHost(r, "/repo", "laptop", undefined)).toBe("laptop");
		expect(await resolveHost(r, "/repo", "laptop", "server")).toBe("server");
		await expect(resolveHost(r, "/repo", "laptop", "nope")).rejects.toThrow(/nicht im Flake/);
		await expect(resolveHost(r, "/repo", "laptop", 'x"; evil')).rejects.toThrow(/Ungültig/);
	});
	it("non-default hosts are refused when the flake cannot list hosts", async () => {
		const r = new FakeRunner(() => ({ code: 1 }));
		await expect(resolveHost(r, "/repo", "laptop", "server")).rejects.toThrow(/nur der Standard-Host/);
	});
	it("another host can be built but never applied to this machine", async () => {
		const repo = gitRepo({ "x.nix": "{ }\n" });
		const runner = nixRunner(["testhost", "server"]);
		const h = harness({ repo, runner });
		dirs.push(repo);
		await call(h, "config_create_module", { path: "y.nix", content: "{ }\n", intent: "neu" });
		const b = await call(h, "nix_build", { host: "server" });
		expect(JSON.parse(b.text)).toMatchObject({ success: true });
		expect(h.deps.work.lastBuild?.host).toBe("server");
		const ctx = { mode: "tui", hasUI: true, ui: { confirm: async () => true, custom: async () => 0 } };
		const r = await call(h, "nix_switch", {}, ctx);
		expect(r.text).toMatch(/nur der lokale Host 'testhost'/);
		expect(runner.calls.some((c) => c.cmd === "nh" || c.cmd === "sudo")).toBe(false);
		h.dispose();
	});
});
