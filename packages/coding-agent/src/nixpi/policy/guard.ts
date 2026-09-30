import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export class GuardError extends Error {}

export const MAX_FILE_BYTES = 256 * 1024;

const SECRET_NAME_PATTERNS = [
	/(^|\/)\.env(\..*)?$/i,
	/(^|\/)secrets?(\/|\.|$)/i,
	/\.(pem|key|p12|pfx|age|gpg|asc|kdbx)$/i,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
	/(^|\/)(auth|credentials?|token|passwd|shadow)(\.[a-z]+)?$/i,
	/(^|\/)\.netrc$/i,
];

export function isSecretPath(relPath: string): boolean {
	const p = relPath.split(sep).join("/");
	return SECRET_NAME_PATTERNS.some((re) => re.test(p));
}

const SECRET_CONTENT_PATTERNS: Array<[string, RegExp]> = [
	["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
	["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
	["Anthropic/OpenAI style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
	["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/],
	["inline password assignment", /\b(password|passwd|secret|api[_-]?key|token)\s*=\s*"[^"\s$]{6,}"/i],
	["hashed password literal", /\b(hashedPassword|initialHashedPassword)\s*=\s*"\$[0-9a-z]+\$/],
	["plain user password", /\b(initialPassword|password)\s*=\s*"[^"$]+"\s*;/],
];

/** Returns a description of the first secret-like thing found, or undefined. */
export function findSecretInContent(content: string): string | undefined {
	for (const [label, re] of SECRET_CONTENT_PATTERNS) if (re.test(content)) return label;
	return undefined;
}

/**
 * Resolve `rel` inside `repo` for reading or writing. Blocks absolute paths, `..`, `.git`, symlink
 * escapes (also for not-yet-existing files via their parent) and optionally secret-looking paths.
 */
export function resolveRepoPath(repo: string, rel: string, opts: { allowSecret?: boolean } = {}): string {
	if (typeof rel !== "string" || rel.length === 0) throw new GuardError("Pfad fehlt");
	if (rel.includes("\0")) throw new GuardError("Ungültiger Pfad");
	if (isAbsolute(rel)) throw new GuardError("Absolute Pfade sind nicht erlaubt");
	const parts = rel.split(/[\\/]+/);
	if (parts.includes("..")) throw new GuardError("'..' ist nicht erlaubt");
	if (parts.includes(".git")) throw new GuardError("Zugriff auf .git ist nicht erlaubt");
	if (!opts.allowSecret && isSecretPath(rel)) throw new GuardError("Secret-Dateien sind gesperrt");

	const root = realpathSync(repo);
	const target = resolve(root, rel);
	// Walk up to the deepest existing ancestor and make sure its real path stays inside the repo.
	let probe = target;
	for (;;) {
		try {
			lstatSync(probe);
			break;
		} catch {
			const parent = resolve(probe, "..");
			if (parent === probe) throw new GuardError("Pfad nicht auflösbar");
			probe = parent;
		}
	}
	const real = realpathSync(probe);
	const relToRoot = relative(root, real);
	if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) throw new GuardError("Symlink-Flucht aus dem Config-Repo");
	if (probe === target && lstatSync(target).isSymbolicLink()) {
		// realpath already resolved it inside the repo; still refuse writing through links.
		if (!opts.allowSecret) throw new GuardError("Symlinks werden nicht gepatcht");
	}
	return join(root, relative(root, target));
}

export function readRepoFile(repo: string, rel: string): string {
	const abs = resolveRepoPath(repo, rel);
	const buf = readFileSync(abs);
	if (buf.length > MAX_FILE_BYTES) throw new GuardError(`Datei zu groß (> ${MAX_FILE_BYTES} Bytes)`);
	return buf.toString("utf-8");
}
