import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { detectSystem, parseOsRelease, parseStateVersion } from "../../src/nixpi/bootstrap/detect.ts";
import { nixpkgsBranch, renderFiles, writeRepo } from "../../src/nixpi/bootstrap/generate.ts";
import { cleanup, tmp, writeFiles } from "./helpers.ts";

const dirs: string[] = [];
const mk = () => {
	const d = tmp();
	dirs.push(d);
	return d;
};
afterEach(() => {
	for (const d of dirs.splice(0)) cleanup(d);
});

const fakeEtc = (id = "nixos") => {
	const etc = mk();
	writeFiles(etc, {
		"os-release": `NAME=NixOS\nID=${id}\nVERSION_ID="25.05.20250101.abc"\n`,
		"nixos/configuration.nix": '{ system.stateVersion = "25.05"; }',
		"nixos/hardware-configuration.nix": "{ boot.initrd.availableKernelModules = [ ]; }",
	});
	return etc;
};

describe("bootstrap detection", () => {
	it("parses os-release and stateVersion", () => {
		expect(parseOsRelease('ID=nixos\nVERSION_ID="25.05"\n')).toMatchObject({ ID: "nixos", VERSION_ID: "25.05" });
		expect(parseStateVersion('system.stateVersion = "24.11";')).toBe("24.11");
	});
	it("recognizes a fresh NixOS and refuses non-NixOS", () => {
		const repo = join(mk(), "nixos-config");
		expect(detectSystem({ etcDir: fakeEtc(), configRepo: repo })).toMatchObject({
			isNixos: true,
			stateVersion: "25.05",
			hasHardwareConfig: true,
			configExists: false,
		});
		expect(detectSystem({ etcDir: fakeEtc("fedora"), configRepo: repo }).isNixos).toBe(false);
	});
	it("nixpkgs branch follows VERSION_ID", () => {
		expect(nixpkgsBranch("25.05.2025")).toBe("nixos-25.05");
		expect(nixpkgsBranch(undefined)).toBe("nixos-unstable");
	});
});

describe("bootstrap repo generation", () => {
	it("creates the V1 structure, copies hardware config, git-inits and commits", () => {
		const etc = fakeEtc();
		const repo = join(mk(), "nixos-config");
		const sys = { ...detectSystem({ etcDir: etc, configRepo: repo }), host: "laptop", user: "gero" };
		const r = writeRepo({ repo, sys, nixpiFlake: "github:owner/nixpi-core" });
		for (const f of [
			"flake.nix",
			"hosts/laptop/default.nix",
			"hosts/laptop/hardware-configuration.nix",
			"system/base.nix",
			"home/default.nix",
			"decisions/.gitkeep",
			".gitignore",
		])
			expect(existsSync(join(repo, f))).toBe(true);
		expect(readFileSync(join(repo, "hosts/laptop/hardware-configuration.nix"), "utf-8")).toContain(
			"availableKernelModules",
		);
		const flake = readFileSync(join(repo, "flake.nix"), "utf-8");
		expect(flake).toContain("nixosConfigurations.laptop");
		expect(flake).toContain("home-manager.nixosModules.home-manager");
		expect(flake).toContain("github:owner/nixpi-core");
		expect(readFileSync(join(repo, "hosts/laptop/default.nix"), "utf-8")).toContain('system.stateVersion = "25.05"');
		expect(readFileSync(join(repo, "system/base.nix"), "utf-8")).toContain("programs.nh.enable");
		expect(readFileSync(join(repo, "system/base.nix"), "utf-8")).toContain("mcp-nixos");
		const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo }).toString();
		if (r.committed) expect(dirty).toBe("");
		else expect(dirty).toContain("flake.nix");
	});
	it("omits NixPi self-declaration without a flake reference", () => {
		const sys = { ...detectSystem({ etcDir: fakeEtc(), configRepo: "/x/y" }), host: "h", user: "u" };
		const f = renderFiles({ repo: "/x", sys }, "{}");
		expect(f["flake.nix"]).not.toContain("nixpi");
		expect(f["hosts/h/default.nix"]).not.toContain("nixpi");
	});
	it("refuses existing non-empty targets, missing stateVersion and hostile identifiers", () => {
		const etc = fakeEtc();
		const repo = mk();
		writeFiles(repo, { "keep.txt": "x" });
		const base = detectSystem({ etcDir: etc, configRepo: repo });
		expect(() => writeRepo({ repo, sys: { ...base, host: "h", user: "u" } })).toThrow(/nicht leer/);
		expect(() => renderFiles({ repo: "/x", sys: { ...base, stateVersion: undefined } }, "{}")).toThrow(
			/stateVersion/,
		);
		expect(() => renderFiles({ repo: "/x", sys: { ...base, host: 'x"; evil' } }, "{}")).toThrow(/Hostname/);
		expect(() => renderFiles({ repo: "/x", sys: { ...base, user: "a b" } }, "{}")).toThrow(/Benutzername/);
	});
});
