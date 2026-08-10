import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	PersistedRunEvent,
	RunRecord,
	WorkflowSnapshot,
} from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";

function privateMkdir(directory: string): void {
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	try {
		fs.chmodSync(directory, 0o700);
	} catch {
		/* Windows and restricted filesystems */
	}
}

function atomicJson(filePath: string, value: unknown): void {
	privateMkdir(path.dirname(filePath));
	const temporary = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
	fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	fs.renameSync(temporary, filePath);
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {
		/* best effort */
	}
}

function safeId(id: string): string {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{5,127}$/.test(id))
		throw new Error(`Invalid run id: ${id}`);
	return id;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export class RunStore {
	readonly root: string;
	private sequences = new Map<string, number>();

	constructor(root = path.join(getAgentDir(), "subagents", "runs")) {
		this.root = root;
		privateMkdir(root);
	}

	runDir(runId: string): string {
		return path.join(this.root, safeId(runId));
	}

	create(record: RunRecord): void {
		const directory = this.runDir(record.id);
		privateMkdir(directory);
		atomicJson(path.join(directory, "manifest.json"), record);
		atomicJson(path.join(directory, "status.json"), record);
		this.appendEvent(record.id, "run.created", record.state, {
			kind: record.kind,
		});
	}

	write(record: RunRecord): void {
		atomicJson(path.join(this.runDir(record.id), "status.json"), record);
	}

	appendEvent(
		runId: string,
		type: string,
		state?: PersistedRunEvent["state"],
		data?: Record<string, unknown>,
	): void {
		const directory = this.runDir(runId);
		privateMkdir(directory);
		let sequence = this.sequences.get(runId);
		if (sequence === undefined) {
			sequence = 0;
			const eventPath = path.join(directory, "events.jsonl");
			try {
				const content = fs.readFileSync(eventPath, "utf8").trim();
				if (content) {
					const finalLine = content.split("\n").at(-1);
					const finalEvent = finalLine
						? (JSON.parse(finalLine) as PersistedRunEvent)
						: undefined;
					sequence = finalEvent?.sequence ?? content.split("\n").length;
				}
			} catch {
				/* start at zero */
			}
		}
		sequence++;
		this.sequences.set(runId, sequence);
		const event: PersistedRunEvent = {
			version: 1,
			sequence,
			timestamp: Date.now(),
			runId,
			type,
			...(state ? { state } : {}),
			...(data ? { data } : {}),
		};
		fs.appendFileSync(
			path.join(directory, "events.jsonl"),
			`${JSON.stringify(event)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
	}

	writeText(runId: string, relativePath: string, content: string): string {
		const directory = this.runDir(runId);
		const resolved = path.resolve(directory, relativePath);
		if (
			resolved !== directory &&
			!resolved.startsWith(`${directory}${path.sep}`)
		)
			throw new Error("Artifact path escapes run directory");
		privateMkdir(path.dirname(resolved));
		fs.writeFileSync(resolved, content, { encoding: "utf8", mode: 0o600 });
		return resolved;
	}

	writeWorkflow(snapshot: WorkflowSnapshot): void {
		atomicJson(
			path.join(this.runDir(snapshot.runId), "workflow.json"),
			snapshot,
		);
	}

	readWorkflow(runId: string): WorkflowSnapshot | undefined {
		try {
			return JSON.parse(
				fs.readFileSync(path.join(this.runDir(runId), "workflow.json"), "utf8"),
			) as WorkflowSnapshot;
		} catch {
			return undefined;
		}
	}

	read(runId: string): RunRecord | undefined {
		try {
			return JSON.parse(
				fs.readFileSync(path.join(this.runDir(runId), "status.json"), "utf8"),
			) as RunRecord;
		} catch {
			return undefined;
		}
	}

	list(limit = 100): RunRecord[] {
		let entries: fs.Dirent[] = [];
		try {
			entries = fs.readdirSync(this.root, { withFileTypes: true });
		} catch {
			return [];
		}
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => this.read(entry.name))
			.filter((record): record is RunRecord => Boolean(record?.version === 1))
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit);
	}

	markInterruptedRunsOrphaned(): RunRecord[] {
		const changed: RunRecord[] = [];
		for (const record of this.list(1000)) {
			if (
				record.state !== "queued" &&
				record.state !== "starting" &&
				record.state !== "running"
			)
				continue;
			const ownerPid =
				typeof record.metadata?.ownerPid === "number"
					? record.metadata.ownerPid
					: undefined;
			if (ownerPid && processIsAlive(ownerPid)) continue;
			record.state = record.state === "queued" ? "cancelled" : "orphaned";
			record.endedAt = Date.now();
			record.updatedAt = record.endedAt;
			record.error = {
				code:
					record.state === "cancelled"
						? "parent_restarted_while_queued"
						: "parent_restarted",
				message:
					record.state === "cancelled"
						? "The parent process restarted before this queued run started."
						: "The parent process exited while this run was active. Resume or restart it explicitly.",
				retryable: true,
			};
			this.write(record);
			this.appendEvent(record.id, `run.${record.state}`, record.state, {
				reason: "startup_reconciliation",
			});
			changed.push(record);
		}
		return changed;
	}

	cleanup(retentionDays: number): number {
		const cutoff = Date.now() - retentionDays * 24 * 60 * 60_000;
		let removed = 0;
		for (const record of this.list(10_000)) {
			if (record.updatedAt >= cutoff || !TERMINAL_STATES.has(record.state))
				continue;
			try {
				fs.rmSync(this.runDir(record.id), { recursive: true, force: true });
				removed++;
			} catch {
				/* best effort */
			}
		}
		return removed;
	}
}
