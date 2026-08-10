import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isWriteCapable } from "./agents.ts";
import { DEFAULT_CONFIG } from "./config.ts";
import { observe } from "./observation.ts";
import { MAX_STDERR_BYTES } from "./protocol.ts";
import { RunStore } from "./run-store.ts";
import { Scheduler } from "./scheduler.ts";
import { runCliAgent } from "./transport.ts";
import type {
	ExtensionConfig,
	ResolvedAgentRunRequest,
	RunRecord,
	RunState,
	RunUpdate,
	TransportEvent,
	TransportResult,
	UsageStats,
} from "./types.ts";
import { snapshotRunRecord, TERMINAL_STATES } from "./types.ts";
import { createWorktree, type WorktreeHandle } from "./worktree.ts";

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function runId(prefix: "agent" | "workflow"): string {
	return `${prefix}_${randomUUID().replace(/-/g, "")}`;
}

function now(): number {
	return Date.now();
}

function emptyUsage(): UsageStats {
	return {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
	};
}

function addUsage(left: UsageStats, right: UsageStats): UsageStats {
	return {
		turns: left.turns + right.turns,
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		cost: left.cost + right.cost,
		contextTokens: right.contextTokens || left.contextTokens,
	};
}

function waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(done, delayMs);
		function done() {
			signal.removeEventListener("abort", abort);
			resolve();
		}
		function abort() {
			clearTimeout(timer);
			signal.removeEventListener("abort", abort);
			reject(signal.reason ?? new Error("Retry cancelled"));
		}
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

function normalizeResourcePath(cwd: string): string {
	const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
		encoding: "utf8",
		windowsHide: true,
	});
	const candidate =
		git.status === 0 && git.stdout.trim() ? git.stdout.trim() : cwd;
	try {
		return fs.realpathSync(candidate);
	} catch {
		return path.resolve(candidate);
	}
}

export interface StartAgentOptions {
	sessionId?: string;
	parentRunId?: string;
	stepId?: string;
	background: boolean;
	priority?: "foreground" | "background";
	signal?: AbortSignal;
	onCreated?: (record: RunRecord) => void;
}

export class SubagentRuntime {
	readonly store: RunStore;
	readonly scheduler: Scheduler;
	private config: ExtensionConfig = DEFAULT_CONFIG;
	private readonly records = new Map<string, RunRecord>();
	private readonly controllers = new Map<string, AbortController>();
	private readonly completions = new Map<string, Deferred<RunRecord>>();
	private readonly detachments = new Map<string, Deferred<void>>();
	private readonly listeners = new Set<(update: RunUpdate) => void>();
	private readonly activities = new Map<string, string[]>();
	private reconciled = false;
	private lastCleanupAt = 0;

	constructor(store = new RunStore()) {
		this.store = store;
		this.scheduler = new Scheduler(DEFAULT_CONFIG.maxConcurrency);
		for (const record of store.list(500)) this.records.set(record.id, record);
		this.reconcileStartup();
	}

	configure(config: ExtensionConfig): void {
		this.config = config;
		this.scheduler.setLimit(config.maxConcurrency);
		if (Date.now() - this.lastCleanupAt > 24 * 60 * 60_000) {
			this.lastCleanupAt = Date.now();
			this.store.cleanup(config.retentionDays);
		}
	}

	getConfig(): ExtensionConfig {
		return this.config;
	}

	subscribe(listener: (update: RunUpdate) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private loadPersisted(limit: number): void {
		for (const record of this.store.list(limit))
			if (!this.records.has(record.id)) this.records.set(record.id, record);
	}

	private getInternal(
		idOrPrefix: string,
		sessionId?: string,
	): RunRecord | undefined {
		const direct = this.records.get(idOrPrefix) ?? this.store.read(idOrPrefix);
		if (direct) {
			this.records.set(direct.id, direct);
			return sessionId === undefined || direct.sessionId === sessionId
				? direct
				: undefined;
		}
		this.loadPersisted(500);
		const matches = [...this.records.values()].filter(
			(record) =>
				record.id.startsWith(idOrPrefix) &&
				(sessionId === undefined || record.sessionId === sessionId),
		);
		if (matches.length > 1)
			throw new Error(
				`Ambiguous run id prefix '${idOrPrefix}'. Matches: ${matches.map((record) => record.id).join(", ")}`,
			);
		return matches[0];
	}

	list(limit = 100): RunRecord[] {
		this.loadPersisted(limit * 2);
		return [...this.records.values()]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit)
			.map(snapshotRunRecord);
	}

	listForSession(sessionId: string, limit = 100): RunRecord[] {
		this.loadPersisted(Number.MAX_SAFE_INTEGER);
		return [...this.records.values()]
			.filter((record) => record.sessionId === sessionId)
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.slice(0, limit)
			.map(snapshotRunRecord);
	}

	get(idOrPrefix: string): RunRecord | undefined {
		const record = this.getInternal(idOrPrefix);
		return record ? snapshotRunRecord(record) : undefined;
	}

	getForSession(idOrPrefix: string, sessionId: string): RunRecord | undefined {
		const record = this.getInternal(idOrPrefix, sessionId);
		return record ? snapshotRunRecord(record) : undefined;
	}

	getActivities(runIdValue: string): string[] {
		return [...(this.activities.get(runIdValue) ?? [])];
	}

	createWorkflowRecord(
		workflow: string,
		input: unknown,
		options: { cwd: string; sessionId?: string; background: boolean },
	): RunRecord {
		const id = runId("workflow");
		const createdAt = now();
		const record: RunRecord = {
			version: 1,
			id,
			kind: "workflow",
			state: "queued",
			background: options.background,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
			workflow,
			cwd: options.cwd,
			workspace: "shared",
			createdAt,
			updatedAt: createdAt,
			usage: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
			},
			metadata: {
				input: structuredClone(input),
				ownerPid: process.pid,
				...(options.background
					? { completionPending: true, completionGeneration: 1 }
					: {}),
			},
		};
		this.records.set(id, record);
		this.store.create(record);
		this.emit({ run: record });
		return snapshotRunRecord(record);
	}

	updateManagedRun(
		runIdValue: string,
		state: RunState,
		patch: Partial<RunRecord> = {},
	): RunRecord {
		const record = this.getInternal(runIdValue);
		if (!record) throw new Error(`Run not found: ${runIdValue}`);
		this.transition(record, state, patch);
		return snapshotRunRecord(record);
	}

	patchManagedRun(runIdValue: string, patch: Partial<RunRecord>): RunRecord {
		const record = this.getInternal(runIdValue);
		if (!record) throw new Error(`Run not found: ${runIdValue}`);
		this.patch(record, patch);
		return snapshotRunRecord(record);
	}

	async startAgent(
		request: ResolvedAgentRunRequest,
		options: StartAgentOptions,
	): Promise<RunRecord> {
		const id = runId("agent");
		const createdAt = now();
		const record: RunRecord = {
			version: 1,
			id,
			kind: "agent",
			state: "queued",
			background: options.background,
			...(options.sessionId ? { sessionId: options.sessionId } : {}),
			...(options.parentRunId ? { parentRunId: options.parentRunId } : {}),
			...(options.stepId ? { stepId: options.stepId } : {}),
			agent: request.agent,
			task: request.task,
			cwd: request.cwd,
			workspace: request.workspace,
			model: request.model ?? request.definition.model,
			thinking: request.thinking ?? request.definition.thinking,
			difficulty: request.difficulty,
			createdAt,
			updatedAt: createdAt,
			usage: {
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
			},
			metadata: {
				agentSource: request.definition.source,
				baseAgent: request.definition.name,
				context: request.context,
				requestedModel: request.model ?? request.definition.model,
				requestedThinking: request.thinking ?? request.definition.thinking,
				difficulty: request.difficulty,
				...(request.profileMaxDifficulty
					? { profileMaxDifficulty: request.profileMaxDifficulty }
					: {}),
				maxTurns: request.maxTurns,
				timeoutMs: request.timeoutMs,
				writeCapable: isWriteCapable(request.definition),
				ownerPid: process.pid,
				...(options.background
					? { completionPending: true, completionGeneration: 1 }
					: {}),
			},
		};
		this.records.set(id, record);
		this.store.create(record);
		this.activities.set(id, []);
		options.onCreated?.(snapshotRunRecord(record));
		const completion = deferred<RunRecord>();
		this.completions.set(id, completion);
		const detachment = deferred<void>();
		this.detachments.set(id, detachment);
		this.emit({ run: record });

		const controller = new AbortController();
		const parentAbort = () => {
			if (record.background) return;
			controller.abort(
				options.signal?.reason ?? new Error("Parent workflow cancelled"),
			);
		};
		if (options.signal?.aborted) parentAbort();
		else options.signal?.addEventListener("abort", parentAbort, { once: true });
		this.controllers.set(id, controller);
		const resources =
			request.workspace === "shared" && isWriteCapable(request.definition)
				? [`workspace-write:${normalizeResourcePath(request.cwd)}`]
				: [];

		const execution = this.scheduler
			.run(() => this.executeAgent(record, request, controller), {
				priority:
					options.priority ??
					(options.background ? "background" : "foreground"),
				signal: controller.signal,
				resources,
				onQueued: (position) => this.patch(record, { queuePosition: position }),
			})
			.catch((error) => {
				if (!TERMINAL_STATES.has(record.state)) {
					this.transition(record, "cancelled", {
						error: {
							code: "cancelled_while_queued",
							message:
								error instanceof Error
									? error.message
									: "Cancelled while queued.",
							retryable: true,
						},
					});
				}
				return record;
			})
			.finally(() => {
				options.signal?.removeEventListener("abort", parentAbort);
				this.controllers.delete(id);
				this.detachments.delete(id);
				completion.resolve(snapshotRunRecord(record));
				this.completions.delete(id);
			});

		if (options.background) {
			void execution;
			return snapshotRunRecord(record);
		}
		await Promise.race([execution, detachment.promise]);
		return snapshotRunRecord(record);
	}

	async wait(
		idOrPrefix: string,
		timeoutMs = 30 * 60_000,
		signal?: AbortSignal,
	): Promise<RunRecord> {
		const record = this.getInternal(idOrPrefix);
		if (!record) throw new Error(`Run not found: ${idOrPrefix}`);
		if (TERMINAL_STATES.has(record.state)) return snapshotRunRecord(record);
		const abortMessage = `Stopped waiting for ${record.id}; the run continues.`;
		const active = this.completions.get(record.id);
		if (active) {
			return observe(active.promise, {
				timeoutMs,
				onTimeout: () =>
					snapshotRunRecord(this.getInternal(record.id) ?? record),
				signal,
				abortMessage,
			});
		}
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			await observe(
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, 250);
					timer.unref?.();
				}),
				{ signal, abortMessage },
			);
			const latest = this.store.read(record.id);
			if (latest) {
				this.records.set(latest.id, latest);
				if (TERMINAL_STATES.has(latest.state)) return snapshotRunRecord(latest);
			}
		}
		return snapshotRunRecord(
			this.store.read(record.id) ?? this.getInternal(record.id) ?? record,
		);
	}

	markCompletionEnqueued(idOrPrefix: string, sessionId: string): RunRecord {
		const record = this.getInternal(idOrPrefix, sessionId);
		if (!record) throw new Error(`Run not found: ${idOrPrefix}`);
		if (
			record.metadata?.completionDeliveredAt ||
			record.metadata?.completionEnqueuedAt
		)
			return snapshotRunRecord(record);
		this.patch(record, {
			metadata: { ...record.metadata, completionEnqueuedAt: now() },
		});
		return snapshotRunRecord(record);
	}

	clearCompletionEnqueued(idOrPrefix: string, sessionId: string): RunRecord {
		const record = this.getInternal(idOrPrefix, sessionId);
		if (!record) throw new Error(`Run not found: ${idOrPrefix}`);
		if (!record.metadata?.completionEnqueuedAt)
			return snapshotRunRecord(record);
		this.patch(record, {
			metadata: { ...record.metadata, completionEnqueuedAt: undefined },
		});
		return snapshotRunRecord(record);
	}

	markCompletionDelivered(idOrPrefix: string, sessionId: string): RunRecord {
		const record = this.getInternal(idOrPrefix, sessionId);
		if (!record) throw new Error(`Run not found: ${idOrPrefix}`);
		if (record.metadata?.completionDeliveredAt)
			return snapshotRunRecord(record);
		this.patch(record, {
			metadata: {
				...record.metadata,
				completionEnqueuedAt: undefined,
				completionDeliveredAt: now(),
			},
		});
		return snapshotRunRecord(record);
	}

	background(idOrPrefix: string, sessionId?: string): RunRecord {
		const record = this.getInternal(idOrPrefix, sessionId);
		if (!record) throw new Error(`Run not found: ${idOrPrefix}`);
		if (record.kind !== "agent" || record.parentRunId)
			throw new Error(
				"Only standalone subagents can be moved to the background.",
			);
		if (TERMINAL_STATES.has(record.state) || record.background)
			return snapshotRunRecord(record);
		if (!this.controllers.has(record.id))
			throw new Error(
				`Run ${record.id} is not owned by this process and cannot be backgrounded safely.`,
			);
		this.patch(record, {
			background: true,
			metadata: {
				...record.metadata,
				manuallyBackgroundedAt: now(),
				completionPending: true,
				completionGeneration:
					Number(record.metadata?.completionGeneration ?? 0) + 1,
				completionEnqueuedAt: undefined,
				completionDeliveredAt: undefined,
			},
		});
		this.store.appendEvent(record.id, "run.backgrounded", record.state, {
			reason: "user_request",
		});
		this.detachments.get(record.id)?.resolve();
		return snapshotRunRecord(record);
	}

	stop(idOrPrefix: string, reason = "Stopped by user"): RunRecord {
		const record = this.getInternal(idOrPrefix);
		if (!record) throw new Error(`Run not found: ${idOrPrefix}`);
		if (TERMINAL_STATES.has(record.state)) return snapshotRunRecord(record);
		const controller = this.controllers.get(record.id);
		if (!controller)
			throw new Error(
				`Run ${record.id} is not owned by this process and cannot be stopped safely.`,
			);
		controller.abort(new Error(reason));
		this.store.appendEvent(record.id, "run.stop_requested", record.state, {
			reason,
		});
		return snapshotRunRecord(record);
	}

	async shutdown(): Promise<void> {
		const pending = [...this.completions.values()].map(
			(completion) => completion.promise,
		);
		for (const [id, controller] of this.controllers)
			controller.abort(new Error(`Parent process shutting down (${id})`));
		await Promise.allSettled(pending);
	}

	private reconcileStartup(): void {
		if (this.reconciled) return;
		this.reconciled = true;
		for (const record of this.store.markInterruptedRunsOrphaned())
			this.records.set(record.id, record);
	}

	private async executeAgent(
		record: RunRecord,
		originalRequest: ResolvedAgentRunRequest,
		controller: AbortController,
	): Promise<void> {
		this.transition(record, "starting", {
			startedAt: now(),
			queuePosition: undefined,
		});
		let worktree: WorktreeHandle | undefined;
		let request = originalRequest;
		try {
			if (request.workspace === "worktree") {
				worktree = createWorktree(request.cwd, record.id);
				request = { ...request, cwd: worktree.cwd };
				this.patch(record, {
					cwd: request.cwd,
					metadata: {
						...record.metadata,
						worktreePath: worktree.path,
						worktreeBranch: worktree.branch,
						sourceCwd: originalRequest.cwd,
					},
				});
			}
			this.transition(record, "running");
			const maxRetries = Math.max(
				0,
				Math.min(request.maxRetries ?? this.config.maxRetries, 5),
			);
			const maxAttempts = maxRetries + 1;
			const deadline = now() + request.timeoutMs;
			let cumulativeUsage = emptyUsage();
			let combinedTranscript: string[] = [];
			let combinedStderr = "";
			let unsafeToolSeen = false;
			let finalResult: TransportResult | undefined;

			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				const remainingMs = Math.max(1, deadline - now());
				this.patch(record, {
					error: undefined,
					metadata: { ...record.metadata, attempt, maxAttempts },
				});
				const usageBeforeAttempt = cumulativeUsage;
				const attemptRequest = { ...request, timeoutMs: remainingMs };
				const result = await runCliAgent({
					runId: record.id,
					runDirectory: this.store.runDir(record.id),
					request: attemptRequest,
					signal: controller.signal,
					resultMaxBytes: this.config.resultMaxBytes,
					transcriptMaxEvents: this.config.transcriptMaxEvents,
					onEvent: (event) => {
						if (
							event.type === "activity" &&
							(event.data?.tool === "bash" ||
								event.data?.tool === "edit" ||
								event.data?.tool === "write")
						)
							unsafeToolSeen = true;
						this.handleTransportEvent(record, event, usageBeforeAttempt);
					},
				});
				cumulativeUsage = addUsage(cumulativeUsage, result.usage);
				combinedTranscript = [
					...combinedTranscript,
					`attempt ${attempt}/${maxAttempts}: ${result.state}${result.error ? `: ${result.error.message}` : ""}`,
					...result.transcript,
				].slice(-this.config.transcriptMaxEvents);
				combinedStderr =
					`${combinedStderr}${combinedStderr && result.stderr ? "\n" : ""}${result.stderr ?? ""}`.slice(
						-MAX_STDERR_BYTES,
					);
				finalResult = {
					...result,
					usage: cumulativeUsage,
					transcript: combinedTranscript,
					stderr: combinedStderr,
				};

				const retryDelayMs = Math.min(
					this.config.retryBaseDelayMs * 2 ** (attempt - 1),
					60_000,
				);
				const canRetry =
					result.state === "failed" &&
					result.error?.retryable === true &&
					attempt < maxAttempts &&
					!unsafeToolSeen &&
					!controller.signal.aborted &&
					now() + retryDelayMs < deadline;
				if (!canRetry || !result.error) break;
				const retryError = result.error.message;

				const message = `retrying ${attempt + 1}/${maxAttempts} in ${retryDelayMs}ms: ${retryError}`;
				const recent = this.activities.get(record.id) ?? [];
				recent.push(message);
				if (recent.length > 20) recent.splice(0, recent.length - 20);
				this.activities.set(record.id, recent);
				this.patch(record, {
					usage: cumulativeUsage,
					activity: { message, updatedAt: now() },
					metadata: {
						...record.metadata,
						retryCount: attempt,
						lastRetryError: retryError,
					},
				});
				this.store.appendEvent(record.id, "run.retry_scheduled", record.state, {
					attempt: attempt + 1,
					maxAttempts,
					delayMs: retryDelayMs,
					error: retryError,
				});
				await waitForRetry(retryDelayMs, controller.signal);
			}

			if (!finalResult)
				throw new Error("Subagent finished without a transport result.");
			this.finalizeTransport(record, finalResult, worktree);
		} catch (error) {
			const cancelled = controller.signal.aborted;
			this.transition(record, cancelled ? "cancelled" : "failed", {
				error: {
					code: cancelled ? "cancelled" : "runtime_error",
					message: error instanceof Error ? error.message : String(error),
					retryable: !cancelled,
				},
			});
		} finally {
			worktree?.cleanup();
		}
	}

	private handleTransportEvent(
		record: RunRecord,
		event: TransportEvent,
		usageOffset: UsageStats = emptyUsage(),
	): void {
		if (event.type === "started" && typeof event.data?.pid === "number") {
			this.patch(record, { pid: event.data.pid });
			return;
		}
		if (event.type === "activity") {
			const message =
				typeof event.data?.message === "string"
					? event.data.message
					: "working";
			const recent = this.activities.get(record.id) ?? [];
			recent.push(message);
			if (recent.length > 20) recent.splice(0, recent.length - 20);
			this.activities.set(record.id, recent);
			this.patch(record, {
				activity: {
					tool:
						typeof event.data?.tool === "string" ? event.data.tool : undefined,
					path:
						typeof event.data?.path === "string" ? event.data.path : undefined,
					message,
					updatedAt: now(),
				},
			});
			return;
		}
		if (event.type === "retry" && event.data) {
			const attempt = Number(event.data.attempt ?? 0);
			const maxAttempts = Number(event.data.maxAttempts ?? 0);
			const delayMs = Number(event.data.delayMs ?? 0);
			const errorMessage =
				typeof event.data.errorMessage === "string"
					? event.data.errorMessage
					: "Transient provider error";
			const message = `provider retry ${attempt}/${maxAttempts} in ${delayMs}ms: ${errorMessage}`;
			const recent = this.activities.get(record.id) ?? [];
			recent.push(message);
			if (recent.length > 20) recent.splice(0, recent.length - 20);
			this.activities.set(record.id, recent);
			this.patch(record, {
				activity: { message, updatedAt: now() },
				metadata: {
					...record.metadata,
					providerRetryAttempt: attempt,
					providerRetryMaxAttempts: maxAttempts,
				},
			});
			return;
		}
		if (event.type === "usage" && event.data) {
			this.patch(record, {
				usage: {
					turns: usageOffset.turns + Number(event.data.turns ?? 0),
					input: usageOffset.input + Number(event.data.input ?? 0),
					output: usageOffset.output + Number(event.data.output ?? 0),
					cacheRead: usageOffset.cacheRead + Number(event.data.cacheRead ?? 0),
					cacheWrite:
						usageOffset.cacheWrite + Number(event.data.cacheWrite ?? 0),
					cost: usageOffset.cost + Number(event.data.cost ?? 0),
					contextTokens: Number(
						event.data.contextTokens ?? usageOffset.contextTokens,
					),
				},
				model:
					typeof event.data.model === "string"
						? event.data.model
						: record.model,
				metadata: {
					...record.metadata,
					...(typeof event.data.selectedModel === "string"
						? { reportedModel: event.data.selectedModel }
						: {}),
					...(typeof event.data.responseModel === "string"
						? { responseModel: event.data.responseModel }
						: {}),
					...(typeof event.data.thinking === "string"
						? { passedThinking: event.data.thinking }
						: {}),
				},
			});
		}
	}

	private finalizeTransport(
		record: RunRecord,
		result: TransportResult,
		worktree?: WorktreeHandle,
	): void {
		const outputArtifact = this.store.writeText(
			record.id,
			"output.md",
			result.fullOutput ?? result.output,
		);
		const transcriptArtifact = this.store.writeText(
			record.id,
			"transcript.log",
			`${result.transcript.join("\n")}\n`,
		);
		let patchArtifact: string | undefined;
		let worktreeSummary: string | undefined;
		if (worktree) {
			const captured = worktree.capturePatch(
				path.join(this.store.runDir(record.id), "changes.patch"),
			);
			patchArtifact = captured.patchPath;
			worktreeSummary = captured.summary;
		}
		this.transition(record, result.state, {
			output: result.output || result.error?.message || "(no output)",
			outputArtifact,
			transcriptArtifact,
			...(patchArtifact ? { patchArtifact } : {}),
			truncated: result.truncated,
			usage: result.usage,
			model: result.model ?? record.model,
			error: result.error,
			metadata: {
				...record.metadata,
				...(worktreeSummary ? { worktreeSummary } : {}),
				...(result.stderr ? { stderrTail: result.stderr } : {}),
			},
		});
	}

	private transition(
		record: RunRecord,
		state: RunState,
		patch: Partial<RunRecord> = {},
	): void {
		const previousState = record.state;
		const resumableWorkflow =
			record.kind === "workflow" &&
			(previousState === "orphaned" || previousState === "failed") &&
			(state === "running" || state === "queued");
		if (
			TERMINAL_STATES.has(previousState) &&
			previousState !== state &&
			!resumableWorkflow
		)
			return;
		Object.assign(record, structuredClone(patch), { state, updatedAt: now() });
		if (resumableWorkflow) record.endedAt = undefined;
		if (TERMINAL_STATES.has(state)) record.endedAt ??= record.updatedAt;
		this.store.write(record);
		this.store.appendEvent(
			record.id,
			`run.${state}`,
			state,
			record.error ? { error: record.error } : undefined,
		);
		this.emit({ run: record, previousState });
	}

	private patch(record: RunRecord, patch: Partial<RunRecord>): void {
		Object.assign(record, structuredClone(patch), { updatedAt: now() });
		this.store.write(record);
		this.emit({ run: record });
	}

	private emit(update: RunUpdate): void {
		for (const listener of this.listeners) {
			try {
				listener({
					run: snapshotRunRecord(update.run),
					...(update.previousState
						? { previousState: update.previousState }
						: {}),
				});
			} catch {
				/* extensions must not break execution */
			}
		}
	}
}

const RUNTIME_SYMBOL = Symbol.for("pi-subagents.runtime.v1");

function adoptCurrentRuntime(runtime: SubagentRuntime): SubagentRuntime {
	// Pi hot reload keeps the process-global runtime so background children survive,
	// but the retained instance still points at the previous module's prototype.
	// Upgrade it in place whenever this module is reloaded instead of replacing it.
	Object.setPrototypeOf(runtime, SubagentRuntime.prototype);
	const state = runtime as unknown as {
		detachments?: Map<string, Deferred<void>>;
	};
	state.detachments ??= new Map<string, Deferred<void>>();
	return runtime;
}

export function getRuntime(): SubagentRuntime {
	const globals = globalThis as typeof globalThis & {
		[RUNTIME_SYMBOL]?: SubagentRuntime;
	};
	globals[RUNTIME_SYMBOL] ??= new SubagentRuntime();
	return adoptCurrentRuntime(globals[RUNTIME_SYMBOL]);
}
