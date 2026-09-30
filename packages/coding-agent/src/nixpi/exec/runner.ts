import { spawn } from "node:child_process";

export interface RunOptions {
	cwd?: string;
	timeoutMs?: number;
	input?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	/** Called for every complete output line (stdout and stderr), e.g. for build progress. */
	onLine?: (line: string) => void;
}

export interface RunResult {
	code: number | null;
	stdout: string;
	stderr: string;
	timedOut: boolean;
	truncated: boolean;
}

/** Executes one fixed binary with an argument vector. Never goes through a shell. */
export interface Runner {
	run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult>;
}

/** Binaries the NixPi tool implementations may run internally (never model-controlled). */
export const ALLOWED_BINARIES: ReadonlySet<string> = new Set([
	"git",
	"nix",
	"nh",
	"nixos-rebuild",
	"systemctl",
	"journalctl",
	"lspci",
	"lsusb",
	"ip",
	"hostnamectl",
	"readlink",
	"rg",
	"grep",
	"nixfmt",
	"alejandra",
	"sudo",
]);

const MAX_OUTPUT_BYTES = 512 * 1024;

export class SystemRunner implements Runner {
	run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
		if (!ALLOWED_BINARIES.has(cmd)) {
			return Promise.reject(new Error(`Binary nicht erlaubt: ${cmd}`));
		}
		return new Promise((resolve) => {
			const child = spawn(cmd, args, {
				cwd: opts.cwd,
				env: opts.env ?? process.env,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				signal: opts.signal,
			});
			let stdout = "";
			let stderr = "";
			let truncated = false;
			let timedOut = false;
			const cap = (cur: string, chunk: Buffer): string => {
				if (cur.length + chunk.length > MAX_OUTPUT_BYTES) {
					truncated = true;
					return (cur + chunk.toString("utf-8")).slice(0, MAX_OUTPUT_BYTES);
				}
				return cur + chunk.toString("utf-8");
			};
			const pending = { out: "", err: "" };
			const feed = (key: "out" | "err", c: Buffer) => {
				if (!opts.onLine) return;
				pending[key] += c.toString("utf-8");
				const parts = pending[key].split(/\r?\n|\r/);
				pending[key] = parts.pop() ?? "";
				for (const l of parts) if (l.trim()) opts.onLine(l);
			};
			child.stdout.on("data", (c: Buffer) => {
				stdout = cap(stdout, c);
				feed("out", c);
			});
			child.stderr.on("data", (c: Buffer) => {
				stderr = cap(stderr, c);
				feed("err", c);
			});
			const timer = opts.timeoutMs
				? setTimeout(() => {
						timedOut = true;
						child.kill("SIGTERM");
					}, opts.timeoutMs)
				: undefined;
			child.on("error", (err) => {
				if (timer) clearTimeout(timer);
				resolve({ code: null, stdout, stderr: stderr || String(err.message), timedOut, truncated });
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				if (opts.onLine) for (const l of [pending.out, pending.err]) if (l.trim()) opts.onLine(l);
				resolve({ code, stdout, stderr, timedOut, truncated });
			});
			if (opts.input !== undefined) child.stdin.end(opts.input);
			else child.stdin.end();
		});
	}
}

/** Test helper / recorder: maps "cmd arg arg" to canned results. */
export class FakeRunner implements Runner {
	calls: Array<{ cmd: string; args: string[]; opts?: RunOptions }> = [];
	private handler: (cmd: string, args: string[]) => Partial<RunResult> | undefined;
	constructor(handler: (cmd: string, args: string[]) => Partial<RunResult> | undefined) {
		this.handler = handler;
	}
	async run(cmd: string, args: string[], opts?: RunOptions): Promise<RunResult> {
		this.calls.push({ cmd, args, opts });
		const r = this.handler(cmd, args) ?? {};
		if (opts?.onLine)
			for (const l of `${r.stdout ?? ""}\n${r.stderr ?? ""}`.split("\n")) if (l.trim()) opts.onLine(l);
		return { code: 0, stdout: "", stderr: "", timedOut: false, truncated: false, ...r };
	}
}
