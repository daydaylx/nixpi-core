import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { nixpiBaseToolDefinitions } from "../../src/nixpi/policy/base-tools.ts";
import { findSecretInContent, GuardError, isSecretPath, resolveRepoPath } from "../../src/nixpi/policy/guard.ts";
import {
	CHANGE_TOOLS,
	initialModeState,
	isToolAllowed,
	MUTATION_TOOLS,
	PLAN_TOOLS,
	toolsForMode,
	transition,
} from "../../src/nixpi/policy/modes.ts";
import { classifyRisk, gateApply, maxRisk } from "../../src/nixpi/policy/risk.ts";
import { cleanup, tmp } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

describe("mode policy", () => {
	it("PLAN has no mutation tools, CHANGE has no ask_user/plan tools", () => {
		const plan = toolsForMode("PLAN");
		for (const m of MUTATION_TOOLS) expect(plan).not.toContain(m);
		expect(plan).toEqual(expect.arrayContaining([...PLAN_TOOLS]));
		const change = toolsForMode("CHANGE");
		for (const p of PLAN_TOOLS) expect(change).not.toContain(p);
		expect(change).toEqual(expect.arrayContaining([...CHANGE_TOOLS]));
	});

	it("no mode ever exposes a free shell or generic write/edit", () => {
		for (const mode of ["PLAN", "CHANGE"] as const)
			for (const t of ["bash", "powershell", "write", "edit", "read", "exec", "shell"])
				expect(isToolAllowed(mode, t, { web: true })).toBe(false);
	});

	it("web tools only appear when web is enabled", () => {
		expect(toolsForMode("CHANGE")).not.toContain("web_search");
		expect(toolsForMode("CHANGE", { web: true })).toContain("web_search");
	});

	it("PLAN -> CHANGE only via explicit user approval of a finalized plan", () => {
		let s = transition(initialModeState(), { type: "enter_plan" });
		// approval without a plan does nothing
		expect(transition(s, { type: "user_approved_execution" }).mode).toBe("PLAN");
		s = transition(s, { type: "plan_finalized", plan: { goal: "g", summary: "s", files: [], risk: "LOW" } });
		expect(s.mode).toBe("PLAN");
		expect(s.planApproved).toBe(false);
		s = transition(s, { type: "user_approved_execution" });
		expect(s.mode).toBe("CHANGE");
		expect(s.planApproved).toBe(true);
	});

	it("manual switch to CHANGE discards plan approval", () => {
		let s = transition(initialModeState(), { type: "enter_plan" });
		s = transition(s, { type: "plan_finalized", plan: { goal: "g", summary: "s", files: [], risk: "HIGH" } });
		s = transition(s, { type: "enter_change" });
		expect(s.planApproved).toBe(false);
	});

	it("plan_finalized is ignored outside PLAN", () => {
		const s = transition(initialModeState(), {
			type: "plan_finalized",
			plan: { goal: "g", summary: "s", files: [], risk: "LOW" },
		});
		expect(s.plan).toBeUndefined();
	});
});

describe("base tools", () => {
	it("returns nothing and never calls the factory", () => {
		let called = false;
		const r = nixpiBaseToolDefinitions(() => {
			called = true;
			return { bash: 1 };
		});
		expect(r).toEqual({});
		expect(called).toBe(false);
	});
});

describe("config scope guard", () => {
	const mk = () => {
		const d = tmp();
		dirs.push(d);
		mkdirSync(join(d, "repo", "sub"), { recursive: true });
		mkdirSync(join(d, "repo", ".git"));
		writeFileSync(join(d, "repo", "a.nix"), "{}");
		return { root: join(d, "repo"), outside: d };
	};

	it("allows normal files and new files in existing dirs", () => {
		const { root } = mk();
		expect(resolveRepoPath(root, "a.nix")).toMatch(/a\.nix$/);
		expect(resolveRepoPath(root, "sub/new.nix")).toMatch(/new\.nix$/);
		expect(resolveRepoPath(root, "deep/er/new.nix")).toMatch(/new\.nix$/);
	});

	it("blocks absolute paths, .. and .git", () => {
		const { root } = mk();
		expect(() => resolveRepoPath(root, "/etc/passwd")).toThrow(GuardError);
		expect(() => resolveRepoPath(root, "../x")).toThrow(GuardError);
		expect(() => resolveRepoPath(root, "sub/../../x")).toThrow(GuardError);
		expect(() => resolveRepoPath(root, ".git/config")).toThrow(GuardError);
		expect(() => resolveRepoPath(root, "sub\\..\\x")).toThrow(GuardError);
	});

	it("blocks symlink escapes (file and directory)", () => {
		const { root, outside } = mk();
		writeFileSync(join(outside, "secret.txt"), "x");
		symlinkSync(join(outside, "secret.txt"), join(root, "link.nix"));
		mkdirSync(join(outside, "dir"));
		symlinkSync(join(outside, "dir"), join(root, "dirlink"));
		expect(() => resolveRepoPath(root, "link.nix")).toThrow(/Symlink/);
		expect(() => resolveRepoPath(root, "dirlink/new.nix")).toThrow(/Symlink/);
	});

	it("blocks secret files", () => {
		const { root } = mk();
		for (const n of [
			".env",
			"secrets.nix",
			"secrets/x.nix",
			"id_ed25519",
			"host.key",
			"sub/.env.local",
			"auth.json",
		]) {
			expect(isSecretPath(n)).toBe(true);
			expect(() => resolveRepoPath(root, n)).toThrow(GuardError);
		}
		expect(isSecretPath("desktop/shortcuts.nix")).toBe(false);
	});

	it("detects secret-looking content", () => {
		expect(findSecretInContent("-----BEGIN OPENSSH PRIVATE KEY-----")).toBeTruthy();
		expect(findSecretInContent('users.users.x.initialPassword = "hunter22";')).toBeTruthy();
		expect(findSecretInContent("token = ghp_abcdefghijklmnopqrstuvwxyz0123456789;")).toBeTruthy();
		expect(findSecretInContent("programs.firefox.enable = true;")).toBeUndefined();
	});
});

describe("risk", () => {
	it("LOW is not needlessly escalated", () => {
		expect(classifyRisk(["desktop/shortcuts.nix"], 'bind = "SUPER, P, exec, pi";')).toBe("LOW");
		expect(classifyRisk(["home/programs.nix"], "home.packages = [ pkgs.firefox ];")).toBe("LOW");
	});
	it("MEDIUM for services/audio/bluetooth/network", () => {
		expect(classifyRisk(["system/bluetooth.nix"], "hardware.bluetooth.enable = true;")).toBe("MEDIUM");
		expect(classifyRisk(["x.nix"], "services.pipewire.enable = true;")).toBe("MEDIUM");
	});
	it("HIGH for boot/kernel/sudo/users/firewall/fs/secrets", () => {
		for (const t of [
			"boot.loader.systemd-boot.enable = true;",
			"boot.kernelPackages = pkgs.linuxPackages_latest;",
			"security.sudo.wheelNeedsPassword = false;",
			"users.users.x.extraGroups = [];",
			"networking.firewall.enable = false;",
			'fileSystems."/" = {};',
			"boot.initrd.luks.devices = {};",
			"sops.secrets.x = {};",
		])
			expect(classifyRisk(["x.nix"], t)).toBe("HIGH");
		expect(classifyRisk(["hardware-configuration.nix"], "")).toBe("HIGH");
	});
	it("maxRisk picks the highest", () => {
		expect(maxRisk("LOW", "HIGH")).toBe("HIGH");
		expect(maxRisk("MEDIUM", "LOW")).toBe("MEDIUM");
	});
	it("gateApply: build required, HIGH requires approved plan, user approval required", () => {
		expect(gateApply({ risk: "LOW", buildSucceeded: false, planApproved: false, userApproved: true }).ok).toBe(false);
		expect(gateApply({ risk: "HIGH", buildSucceeded: true, planApproved: false, userApproved: true })).toMatchObject({
			ok: false,
		});
		expect(gateApply({ risk: "HIGH", buildSucceeded: true, planApproved: true, userApproved: false }).ok).toBe(false);
		expect(gateApply({ risk: "HIGH", buildSucceeded: true, planApproved: true, userApproved: true }).ok).toBe(true);
		expect(gateApply({ risk: "LOW", buildSucceeded: true, planApproved: false, userApproved: true }).ok).toBe(true);
	});
});
