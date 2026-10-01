import * as fs from "node:fs";
import * as path from "node:path";
import type { Usage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	type SessionBoundaryDraft,
	type SessionEntry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { truncateUtf8 } from "./protocol.ts";
import { isTransientTransportError } from "./transport.ts";
import type {
	ResolvedAgentRunRequest,
	TransportEvent,
	TransportResult,
	UsageStats,
} from "./types.ts";

export interface ChildInvocation {
	request: ResolvedAgentRunRequest;
	sessionFile: string;
	resultMaxBytes: number;
	transcriptMaxEvents: number;
}

export function sessionUsage(entries: SessionEntry[]): UsageStats {
	const total: UsageStats = {
		turns: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		contextTokens: 0,
	};
	for (const entry of entries) {
		let usage: Usage | undefined;
		if (entry.type === "message" && entry.message.role === "assistant") {
			total.turns++;
			usage = entry.message.usage;
			total.contextTokens = usage.totalTokens;
		} else if (entry.type === "message" && entry.message.role === "toolResult")
			usage = entry.message.usage;
		else if (
			entry.type === "usage" ||
			entry.type === "compaction" ||
			entry.type === "branch_summary"
		)
			usage = entry.usage;
		if (!usage) continue;
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost += usage.cost.total;
	}
	return total;
}

export function restoreChildSession(
	file: string,
	cwd: string,
	id?: string,
): SessionManager {
	if (!fs.existsSync(file))
		return SessionManager.inMemory(cwd, id ? { id } : undefined);
	const stored = JSON.parse(fs.readFileSync(file, "utf8")) as {
		version?: number;
		id?: string;
		entries?: SessionEntry[];
	};
	if (
		stored.version !== 1 ||
		typeof stored.id !== "string" ||
		!Array.isArray(stored.entries) ||
		(id && stored.id !== id)
	)
		throw new Error("Invalid canonical child session checkpoint.");
	const manager = SessionManager.inMemory(
		cwd,
		{ id: stored.id },
		stored.entries,
	);
	const messages = manager.buildSessionContext().messages;
	const lastAssistant = [...messages]
		.reverse()
		.find((message) => message.role === "assistant");
	if (lastAssistant?.role === "assistant") {
		const tail = messages.slice(messages.indexOf(lastAssistant) + 1);
		const results = new Set(
			tail
				.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId),
		);
		for (const call of lastAssistant.content) {
			if (call.type !== "toolCall" || results.has(call.id)) continue;
			if (
				tail.some(
					(message) => message.role === "user" || message.role === "assistant",
				)
			)
				throw new Error(
					"Invalid checkpoint: unresolved tool calls precede another conversation turn.",
				);
			manager.appendMessage({
				role: "toolResult",
				toolCallId: call.id,
				toolName: call.name,
				content: [
					{
						type: "text",
						text: "Previous child invocation was interrupted before this tool result was persisted. Side effects may have occurred. Inspect the workspace before retrying; do not assume failure means nothing changed.",
					},
				],
				isError: true,
				timestamp: Date.now(),
			});
		}
	}
	return manager;
}

function checkpoint(file: string, manager: SessionManager): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(
		temporary,
		JSON.stringify({
			version: 1,
			id: manager.getSessionId(),
			entries: manager.getEntries(),
		}),
		{ mode: 0o600 },
	);
	fs.renameSync(temporary, file);
}

/** The process owns one invocation; canonical entries outlive it, never Agent.state. */
export class IsolatedChildSession {
	private session?: AgentSession;
	private aborted = false;
	constructor(
		private readonly dependencies: {
			agentDir?: string;
			modelRuntime?: ModelRuntime;
			createSession?: typeof createAgentSession;
		} = {},
	) {}

	async invoke(
		input: ChildInvocation,
		onEvent: (event: TransportEvent) => void,
	): Promise<TransportResult> {
		if (this.session) throw new Error("Child invocation already started.");
		const { request } = input;
		const agentDir = this.dependencies.agentDir ?? getAgentDir();
		const settingsManager = SettingsManager.create(request.cwd, agentDir, {
			projectTrusted: request.projectTrusted === true,
		});
		// An invocation may warm during tools, but never spend while unscheduled.
		if (settingsManager.getCacheWarmingMode() === "idle")
			settingsManager.applyOverrides({ cacheWarming: "streaming" });
		let turns = 0;
		let handoff = false;
		let limited = false;
		let compactionError: string | undefined;
		const loader = new DefaultResourceLoader({
			cwd: request.cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: !request.definition.inheritProjectContext,
			additionalSkillPaths: request.skillPaths ?? [],
			systemPromptOverride: () =>
				request.definition.systemPromptMode === "replace"
					? request.systemPrompt
					: undefined,
			appendSystemPromptOverride: () =>
				request.definition.systemPromptMode === "append"
					? [request.systemPrompt]
					: [],
			extensionFactories: [
				(pi) => {
					const finalHandoff = (event: {
						entries: SessionBoundaryDraft[];
						outcome: string;
					}) => {
						if (
							handoff ||
							turns >= request.maxTurns ||
							event.outcome !== "completed" ||
							this.aborted
						)
							return;
						handoff = true;
						pi.setActiveTools([]);
						return {
							entries: [
								...event.entries,
								{
									type: "custom_message" as const,
									customType: "pi-subagents-handoff",
									content:
										"Produce a concise final handoff now: results, changed files, validation, and remaining risks. Do not call tools or start more work.",
									display: false,
								},
							],
							continue: true,
						};
					};
					pi.on("turn_end", (event) => {
						if (
							turns >= request.maxTurns - 1 &&
							event.message.role === "assistant" &&
							event.message.content.some((part) => part.type === "toolCall")
						)
							return finalHandoff(event);
					});
					pi.on("agent_before_settle", (event) => {
						const last = [...event.context.contextMessages]
							.reverse()
							.find((message) => message.role === "assistant");
						if (
							last?.role === "assistant" &&
							!last.content.some(
								(part) => part.type === "text" && part.text.trim(),
							)
						)
							return finalHandoff(event);
					});
					pi.on("tool_call", () =>
						handoff
							? { block: true, reason: "Final handoff is tool-free." }
							: undefined,
					);
					pi.on("session_compact_failed", (event) => {
						compactionError = `Compaction ${event.reason}: ${event.aborted ? "aborted" : (event.errorMessage ?? "failed")}`;
						onEvent({
							type: "diagnostic",
							data: { message: compactionError, ...event },
						});
					});
				},
			],
		});
		await loader.reload();
		if (loader.getExtensions().errors.length)
			throw new Error("Failed to load child lifecycle extension.");
		const modelRuntime =
			this.dependencies.modelRuntime ??
			(await ModelRuntime.create({
				authPath: path.join(agentDir, "auth.json"),
				modelsPath: path.join(agentDir, "models.json"),
			}));
		const spec = request.model ?? request.definition.model;
		const slash = spec?.indexOf("/") ?? -1;
		const model =
			spec && slash > 0
				? modelRuntime.getModel(spec.slice(0, slash), spec.slice(slash + 1))
				: undefined;
		if (spec && !model) throw new Error(`Unknown child model '${spec}'.`);
		const manager = restoreChildSession(
			input.sessionFile,
			request.cwd,
			request.childSessionId,
		);
		const created = await (
			this.dependencies.createSession ?? createAgentSession
		)({
			cwd: request.cwd,
			agentDir,
			modelRuntime,
			model,
			thinkingLevel: request.thinking ?? request.definition.thinking,
			tools: request.definition.tools,
			resourceLoader: loader,
			settingsManager,
			sessionManager: manager,
		});
		const session = created.session;
		this.session = session;
		await session.bindExtensions({ mode: "json" });
		if (this.aborted) throw new Error("Child cancelled during initialization.");
		const prepareRequest = session.agent.prepareRequest;
		session.agent.prepareRequest = async (context, signal) => {
			if (turns >= request.maxTurns) {
				limited = true;
				throw new Error(
					`Child maxTurns budget exhausted (${request.maxTurns}).`,
				);
			}
			return (await prepareRequest?.(context, signal)) ?? undefined;
		};
		const finishTurn = session.agent.finishTurn;
		session.agent.finishTurn = async (turn, signal) => {
			const decision = await finishTurn?.(turn, signal);
			if (
				turn.message.stopReason === "error" ||
				turn.message.stopReason === "aborted"
			)
				return decision ?? undefined;
			if (turns >= request.maxTurns) {
				limited = turn.message.stopReason === "toolUse";
				session.clearQueue();
				return { action: "end" };
			}
			return decision ?? undefined;
		};
		const startEntry = manager.getEntries().length;
		const transcript: string[] = [];
		const remember = (text: string) => {
			transcript.push(text);
			if (transcript.length > input.transcriptMaxEvents) transcript.shift();
		};
		let final = "";
		let settled = false;
		let stopError: string | undefined;
		let modelMismatch: string | undefined;
		let selectedModel = request.model;
		let responseModel: string | undefined;
		let reportedModel = request.model;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				const args = event.args as { path?: string; command?: string };
				const message = `${event.toolName}: ${args.path ?? args.command?.replace(/\s+/g, " ").slice(0, 100) ?? "working"}`;
				remember(message);
				onEvent({
					type: "activity",
					data: { tool: event.toolName, path: args.path, message },
				});
			}
			if (event.type === "auto_retry_start")
				onEvent({ type: "retry", data: { ...event } });
			if (event.type === "message_end" && event.message.role === "assistant") {
				turns++;
				const message = event.message;
				selectedModel = `${message.provider}/${message.model}`;
				responseModel = message.responseModel;
				reportedModel = `${message.provider}/${responseModel ?? message.model}`;
				if (request.model && request.model !== selectedModel) {
					modelMismatch = `Requested child model ${request.model}, but Pi reported ${selectedModel}.`;
					this.aborted = true;
					session.clearQueue();
					session.agent.abort();
				}
				stopError =
					modelMismatch ??
					(message.stopReason === "error"
						? (message.errorMessage ?? "The model reported an error.")
						: undefined);
				final =
					message.stopReason === "stop" || message.stopReason === "length"
						? message.content
								.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n")
								.trim()
						: "";
				remember(`assistant: ${final.slice(0, 500) || message.stopReason}`);
			}
			if (
				event.type === "message_end" ||
				event.type === "turn_end" ||
				event.type === "agent_settled"
			) {
				checkpoint(input.sessionFile, manager);
				onEvent({
					type: "usage",
					data: {
						...sessionUsage(manager.getEntries().slice(startEntry)),
						model: reportedModel,
						selectedModel,
						responseModel,
						thinking: session.thinkingLevel,
					},
				});
			}
			if (event.type === "agent_settled") {
				settled = true;
				onEvent({ type: "settled" });
			}
		});
		try {
			await session.prompt(`Task: ${request.task}`, {
				expandPromptTemplates: false,
			});
		} catch (error) {
			stopError =
				modelMismatch ??
				(error instanceof Error ? error.message : String(error));
		} finally {
			unsubscribe();
			checkpoint(input.sessionFile, manager);
		}
		const usage = sessionUsage(manager.getEntries().slice(startEntry));
		const bounded = truncateUtf8(final, input.resultMaxBytes);
		const error = stopError
			? {
					code: limited ? "max_turns" : "model_or_spawn_error",
					message: stopError,
					retryable: !limited && isTransientTransportError(stopError),
				}
			: !settled || !final
				? {
						code: limited ? "max_turns" : "incomplete_child_protocol",
						message:
							compactionError ??
							(limited
								? `The subagent reached ${request.maxTurns} assistant turns without a final result.`
								: "Child did not settle with an authoritative final assistant result."),
						retryable: false,
					}
				: undefined;
		return {
			state: error ? "failed" : "succeeded",
			output: bounded.text,
			fullOutput: final,
			usage,
			model: reportedModel,
			error,
			transcript,
			truncated: bounded.truncated,
		};
	}

	async abort(): Promise<void> {
		this.aborted = true;
		this.session?.clearQueue();
		await this.session?.abort();
	}
	dispose(): void {
		this.session?.dispose();
		this.session = undefined;
	}
}
