import type { Risk } from "./modes.ts";

const HIGH_PATH = [
	/(^|\/)(hardware-configuration|boot|bootloader|kernel|disk|disko|filesystem|luks|encryption|sops|secrets?|firewall|users?|security|sudo)[^/]*\.nix$/i,
	/(^|\/)flake\.nix$/i,
];
const HIGH_CONTENT = [
	/\bboot\.(loader|kernelPackages|kernelParams|initrd|kernelModules|supportedFilesystems)\b/,
	/\bsecurity\.(sudo|doas|polkit|pam|wrappers)\b/,
	/\busers\.(users|groups|mutableUsers)\b/,
	/\bnetworking\.(firewall|nftables)\b/,
	/\bfileSystems\b|\bswapDevices\b|\bboot\.loader\b|\bluks\b|\bsops\b|\bage\.(secretsDir|identityPaths)\b/,
	/\bnix\.settings\.(trusted-users|allowed-users)\b/,
	/\bservices\.openssh\b/,
];
const MEDIUM_PATH = [/(^|\/)(networking|audio|bluetooth|power|services?|docker|virtualisation)[^/]*\.nix$/i];
const MEDIUM_CONTENT = [
	/\bservices\.[A-Za-z0-9_.-]+\.enable\b/,
	/\bsystemd\.(services|user|timers)\b/,
	/\b(hardware\.bluetooth|hardware\.pulseaudio|services\.pipewire|networking\.|virtualisation\.)/,
	/\bservices\.logind\b/,
];

/**
 * Classify a change from the touched files and the added/removed text. Conservative: the highest
 * matching class wins.
 */
export function classifyRisk(files: string[], changedText = ""): Risk {
	const hay = changedText;
	if (files.some((f) => HIGH_PATH.some((re) => re.test(f))) || HIGH_CONTENT.some((re) => re.test(hay))) return "HIGH";
	if (files.some((f) => MEDIUM_PATH.some((re) => re.test(f))) || MEDIUM_CONTENT.some((re) => re.test(hay)))
		return "MEDIUM";
	return "LOW";
}

export const maxRisk = (a: Risk, b: Risk): Risk => {
	const order: Risk[] = ["LOW", "MEDIUM", "HIGH"];
	return order[Math.max(order.indexOf(a), order.indexOf(b))]!;
};

export interface GateInput {
	risk: Risk;
	buildSucceeded: boolean;
	/** A finished PLAN that the user approved for execution. */
	planApproved: boolean;
	/** Explicit user confirmation for this apply. */
	userApproved: boolean;
}

export type GateDecision = { ok: true } | { ok: false; reason: string };

/** Gate for the privileged apply step (`nix_switch` / `nix_test`). */
export function gateApply(input: GateInput): GateDecision {
	if (!input.buildSucceeded) return { ok: false, reason: "Kein erfolgreicher Build für diesen Stand – erst bauen." };
	if (input.risk === "HIGH" && !input.planApproved)
		return { ok: false, reason: "HIGH-Risiko: zuerst im PLAN-Modus planen und den Plan ausführen lassen." };
	if (!input.userApproved) return { ok: false, reason: "Keine Nutzerfreigabe für das Anwenden." };
	return { ok: true };
}
