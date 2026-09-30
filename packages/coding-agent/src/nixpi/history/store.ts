import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Risk } from "../policy/modes.ts";

export type ChangeStatus = "prepared" | "built" | "applied" | "committed" | "failed" | "rolled_back";

/** Everything needed to later answer what was changed, and why. */
export interface ChangeSet {
	id: string;
	createdAt: string;
	userIntent: string;
	mode: "CHANGE";
	risk: Risk;
	scope: string[];
	files: string[];
	verifiedOptions: string[];
	verifiedPackages: string[];
	planReference?: string;
	buildResult?: { success: boolean; outPath?: string; fingerprint?: string };
	applyResult?: { kind: "test" | "switch"; exitCode: number | null; at: string };
	healthResult?: { ok: boolean; state: string; failedUnits: string[] };
	gitCommit?: string;
	generation?: number;
	decisionRecord?: string;
	status: ChangeStatus;
}

export class ChangeStore {
	private file: string;
	constructor(stateDir: string) {
		this.file = join(stateDir, "changesets.json");
	}

	private read(): ChangeSet[] {
		if (!existsSync(this.file)) return [];
		try {
			return JSON.parse(readFileSync(this.file, "utf-8")) as ChangeSet[];
		} catch {
			return [];
		}
	}

	private write(all: ChangeSet[]): void {
		mkdirSync(dirname(this.file), { recursive: true });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
		renameSync(tmp, this.file);
	}

	create(init: Pick<ChangeSet, "userIntent" | "risk"> & Partial<ChangeSet>): ChangeSet {
		const all = this.read();
		const cs: ChangeSet = {
			id: `cs-${new Date()
				.toISOString()
				.replace(/[-:T.Z]/g, "")
				.slice(0, 14)}-${all.length + 1}`,
			createdAt: new Date().toISOString(),
			mode: "CHANGE",
			scope: [],
			files: [],
			verifiedOptions: [],
			verifiedPackages: [],
			status: "prepared",
			...init,
		};
		all.push(cs);
		this.write(all);
		return cs;
	}

	update(id: string, patch: Partial<ChangeSet>): ChangeSet {
		const all = this.read();
		const i = all.findIndex((c) => c.id === id);
		if (i < 0) throw new Error(`ChangeSet nicht gefunden: ${id}`);
		all[i] = { ...all[i]!, ...patch, id };
		this.write(all);
		return all[i]!;
	}

	get(id: string): ChangeSet | undefined {
		return this.read().find((c) => c.id === id);
	}

	list(limit = 20): ChangeSet[] {
		return this.read().slice(-limit).reverse();
	}

	latest(): ChangeSet | undefined {
		return this.read().at(-1);
	}

	byFile(file: string): ChangeSet[] {
		return this.read()
			.filter((c) => c.files.includes(file))
			.reverse();
	}
}

/** Commit message is derived from the stored intent, never from free model text. */
export function commitMessage(cs: Pick<ChangeSet, "id" | "userIntent" | "risk" | "files" | "generation">): string {
	const subject =
		cs.userIntent
			.replace(/\s+/g, " ")
			.trim()
			.replace(/[^\p{L}\p{N} .,:;()/+_-]/gu, "")
			.slice(0, 68) || "Änderung";
	const lines = [`nixpi: ${subject}`, "", `ChangeSet: ${cs.id}`, `Risk: ${cs.risk}`];
	if (cs.generation !== undefined) lines.push(`Generation: ${cs.generation}`);
	if (cs.files.length) lines.push(`Files: ${cs.files.join(", ")}`);
	return lines.join("\n");
}
