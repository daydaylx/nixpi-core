import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Runner } from "../exec/runner.ts";

export interface OptionHit {
	name: string;
	type?: string;
	description?: string;
	source: string;
}
export interface PackageHit {
	name: string;
	version?: string;
	description?: string;
	source: string;
}

/** Source of verified NixOS / Home Manager / nixpkgs knowledge. */
export interface KnowledgeBackend {
	readonly id: string;
	searchOptions(query: string): Promise<OptionHit[]>;
	optionInfo(name: string): Promise<OptionHit | undefined>;
	searchPackages(query: string): Promise<PackageHit[]>;
	packageInfo(name: string): Promise<PackageHit | undefined>;
}

/** Tries backends in order; a backend that throws (e.g. mcp-nixos unreachable) is skipped. */
export class FallbackKnowledge implements KnowledgeBackend {
	readonly id = "fallback";
	errors: string[] = [];
	private backends: KnowledgeBackend[];
	constructor(backends: KnowledgeBackend[]) {
		this.backends = backends;
	}
	private async first<T>(fn: (b: KnowledgeBackend) => Promise<T>, isEmpty: (v: T) => boolean): Promise<T> {
		let last: T | undefined;
		for (const b of this.backends) {
			try {
				const v = await fn(b);
				if (!isEmpty(v)) return v;
				last = v;
			} catch (e) {
				this.errors.push(`${b.id}: ${e instanceof Error ? e.message : String(e)}`);
			}
		}
		if (last !== undefined) return last;
		throw new Error(`Kein Wissens-Backend erreichbar (${this.errors.slice(-this.backends.length).join("; ")})`);
	}
	searchOptions(q: string) {
		return this.first(
			(b) => b.searchOptions(q),
			(v) => v.length === 0,
		);
	}
	optionInfo(n: string) {
		return this.first(
			(b) => b.optionInfo(n),
			(v) => v === undefined,
		);
	}
	searchPackages(q: string) {
		return this.first(
			(b) => b.searchPackages(q),
			(v) => v.length === 0,
		);
	}
	packageInfo(n: string) {
		return this.first(
			(b) => b.packageInfo(n),
			(v) => v === undefined,
		);
	}
}

/** Minimal stdio JSON-RPC (MCP) client – just `initialize` and `tools/call`. */
export class McpStdioClient {
	private child?: ChildProcessWithoutNullStreams;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
	private buf = "";
	private cmd: string;
	private args: string[];
	private timeoutMs: number;
	constructor(cmd: string, args: string[], timeoutMs = 20000) {
		this.cmd = cmd;
		this.args = args;
		this.timeoutMs = timeoutMs;
	}

	private start(): void {
		if (this.child) return;
		const child = spawn(this.cmd, this.args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
		child.stdout.on("data", (c: Buffer) => {
			this.buf += c.toString("utf-8");
			let i = this.buf.indexOf("\n");
			while (i >= 0) {
				const line = this.buf.slice(0, i).trim();
				this.buf = this.buf.slice(i + 1);
				i = this.buf.indexOf("\n");
				if (!line) continue;
				try {
					const msg = JSON.parse(line);
					const p = typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
					if (!p) continue;
					this.pending.delete(msg.id);
					if (msg.error) p.reject(new Error(msg.error.message ?? "MCP-Fehler"));
					else p.resolve(msg.result);
				} catch {
					/* ignore non-JSON log lines */
				}
			}
		});
		child.stdin.on("error", () => {});
		// Drain diagnostics so a noisy server cannot block on its stderr pipe. Never forward them
		// to the model; tool errors are returned through the MCP result instead.
		child.stderr.on("data", () => {});
		const fail = (e: Error) => {
			if (this.child !== child) return;
			for (const p of this.pending.values()) p.reject(e);
			this.pending.clear();
			this.child = undefined;
			this.initialized = undefined;
		};
		child.on("error", fail);
		child.on("close", () => fail(new Error("mcp-nixos beendet")));
		this.child = child;
	}

	private request(method: string, params: unknown): Promise<any> {
		this.start();
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const t = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`MCP-Timeout bei ${method}`));
				this.child?.kill();
			}, this.timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(t);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(t);
					reject(e);
				},
			});
			this.child!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
		});
	}

	private initialized?: Promise<void>;
	private async init(): Promise<void> {
		this.initialized ??= this.request("initialize", {
			protocolVersion: "2024-11-05",
			capabilities: {},
			clientInfo: { name: "nixpi", version: "0.1.0" },
		}).then((result) => {
			if (result?.protocolVersion !== "2024-11-05")
				throw new Error(`Nicht unterstützte MCP-Protokollversion: ${String(result?.protocolVersion ?? "fehlt")}`);
			this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
		});
		return this.initialized;
	}

	async callTool(name: string, args: Record<string, unknown>): Promise<string> {
		await this.init();
		const res = await this.request("tools/call", { name, arguments: args });
		const text = (res?.content ?? [])
			.filter((c: { type: string }) => c.type === "text")
			.map((c: { text: string }) => c.text)
			.join("\n");
		if (res?.isError) throw new Error(text || "MCP-Tool-Fehler");
		return text;
	}

	close(): void {
		const child = this.child;
		this.child = undefined;
		this.initialized = undefined;
		this.buf = "";
		for (const p of this.pending.values()) p.reject(new Error("mcp-nixos client geschlossen"));
		this.pending.clear();
		child?.kill();
	}
}

/**
 * `mcp-nixos` backend. The server exposes a single `nix` tool with `action`/`query`/`source`
 * parameters (action: search | info | ...). Its free-text reply is kept verbatim; names are
 * extracted line-wise so callers can match exact names.
 */
export class McpNixosBackend implements KnowledgeBackend {
	readonly id = "mcp-nixos";
	private client: Pick<McpStdioClient, "callTool">;
	constructor(client: Pick<McpStdioClient, "callTool">) {
		this.client = client;
	}

	private parse(text: string, source: string): Array<{ name: string; description: string; source: string }> {
		const out: Array<{ name: string; description: string; source: string }> = [];
		for (const line of text.split("\n")) {
			const m = line.match(
				/^[\s*\-•]*([A-Za-z0-9_.@+-]+(?:\.[A-Za-z0-9_<>@.*-]+)+|[A-Za-z0-9_+-]+)\s*(?:\(([^)]*)\))?\s*[:–-]?\s*(.*)$/,
			);
			if (m?.[1] && /[A-Za-z]/.test(m[1]))
				out.push({ name: m[1], description: [m[2], m[3]].filter(Boolean).join(" ").trim(), source });
		}
		return out;
	}

	async searchOptions(query: string): Promise<OptionHit[]> {
		const t = await this.client.callTool("nix", {
			action: "search",
			query,
			source: "nixos",
			type: "options",
		});
		return this.parse(t, "mcp-nixos:options").map((h) => ({ ...h }));
	}
	async optionInfo(name: string): Promise<OptionHit | undefined> {
		const t = await this.client.callTool("nix", {
			action: "info",
			query: name,
			source: "nixos",
			type: "option",
		});
		if (!t || /not found|nicht gefunden/i.test(t)) return undefined;
		return {
			name,
			description: t.slice(0, 2000),
			type: t.match(/Type:\s*(.+)/i)?.[1]?.trim(),
			source: "mcp-nixos:options",
		};
	}
	async searchPackages(query: string): Promise<PackageHit[]> {
		const t = await this.client.callTool("nix", {
			action: "search",
			query,
			source: "nixos",
			type: "packages",
		});
		return this.parse(t, "mcp-nixos:packages");
	}
	async packageInfo(name: string): Promise<PackageHit | undefined> {
		const t = await this.client.callTool("nix", {
			action: "info",
			query: name,
			source: "nixos",
			type: "package",
		});
		if (!t || /not found|nicht gefunden/i.test(t)) return undefined;
		return {
			name,
			description: t.slice(0, 2000),
			version: t.match(/Version:\s*(\S+)/i)?.[1],
			source: "mcp-nixos:packages",
		};
	}
}

/** Local backend: evaluates against the user's own flake, so results match the real system. */
export class LocalNixBackend implements KnowledgeBackend {
	readonly id = "local-nix";
	private runner: Runner;
	private repo: string;
	private host: string;
	constructor(runner: Runner, repo: string, host: string) {
		this.runner = runner;
		this.repo = repo;
		this.host = host;
	}

	private attrPath(name: string): string | undefined {
		return /^[A-Za-z0-9_.-]+$/.test(name) ? name : undefined;
	}

	async searchOptions(): Promise<OptionHit[]> {
		// Full-text option search needs an index; the local backend can only confirm exact names.
		return [];
	}

	async optionInfo(name: string): Promise<OptionHit | undefined> {
		const attr = this.attrPath(name);
		if (!attr || /["\\$]/.test(this.repo + this.host)) return undefined;
		const expr = `let o = (builtins.getFlake "path:${this.repo}").nixosConfigurations.${this.host}.options.${attr}; in { type = o.type.description or o.type.name; description = if builtins.isAttrs (o.description or null) then (o.description.text or "") else (o.description or ""); }`;
		const r = await this.runner.run("nix", ["eval", "--json", "--impure", "--expr", expr], { timeoutMs: 120000 });
		if (r.code !== 0) return undefined;
		try {
			const j = JSON.parse(r.stdout) as { type?: string; description?: string };
			return { name, type: j.type, description: j.description, source: "local-nix:eval" };
		} catch {
			return undefined;
		}
	}

	async searchPackages(query: string): Promise<PackageHit[]> {
		const r = await this.runner.run("nix", ["search", "nixpkgs", query, "--json"], { timeoutMs: 120000 });
		if (r.code !== 0) throw new Error(r.stderr.slice(0, 300) || "nix search fehlgeschlagen");
		const j = JSON.parse(r.stdout || "{}") as Record<
			string,
			{ pname?: string; version?: string; description?: string }
		>;
		return Object.entries(j)
			.slice(0, 25)
			.map(([attr, v]) => ({
				name: attr.replace(/^legacyPackages\.[^.]+\./, ""),
				version: v.version,
				description: v.description,
				source: "local-nix:search",
			}));
	}

	async packageInfo(name: string): Promise<PackageHit | undefined> {
		const attr = this.attrPath(name);
		if (!attr) return undefined;
		const r = await this.runner.run(
			"nix",
			["eval", "--json", `nixpkgs#${attr}.meta`, "--apply", 'm: { description = m.description or ""; }'],
			{ timeoutMs: 120000 },
		);
		if (r.code !== 0) return undefined;
		try {
			const j = JSON.parse(r.stdout) as { description?: string };
			return { name, description: j.description, source: "local-nix:eval" };
		} catch {
			return undefined;
		}
	}
}

/** Records which options/packages were verified in this session; config_patch consults it. */
export class VerificationLedger {
	readonly options = new Set<string>();
	readonly packages = new Set<string>();
}
