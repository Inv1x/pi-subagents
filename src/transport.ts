import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { createByteTail, createLineReader, truncateUtf8 } from "./protocol.ts";
import type {
	ResolvedAgentRunRequest,
	RunError,
	TransportEvent,
	TransportResult,
	UsageStats,
} from "./types.ts";

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

export function isTransientTransportError(message: string): boolean {
	return /websocket|connection (?:closed|reset|refused|lost)|socket hang up|econnreset|econnrefused|etimedout|network error|fetch failed|stream (?:closed|disconnected|terminated)|rate limit|too many requests|\b429\b|\b5\d\d\b|overloaded|temporar(?:y|ily) unavailable|service unavailable|internal server error/i.test(
		message,
	);
}

function qualifiedModel(
	provider: string | undefined,
	model: string | undefined,
): string | undefined {
	if (!model) return undefined;
	return provider && !model.startsWith(`${provider}/`)
		? `${provider}/${model}`
		: model;
}

function sameSelectedModel(requested: string, reported: string): boolean {
	if (requested.toLowerCase() === reported.toLowerCase()) return true;
	if (!requested.includes("/"))
		return (
			reported.slice(reported.indexOf("/") + 1).toLowerCase() ===
			requested.toLowerCase()
		);
	return false;
}

interface AssistantPayload {
	content: Array<Record<string, unknown>>;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		totalTokens?: number;
		cost?: { total?: number };
	};
	provider?: string;
	model?: string;
	responseModel?: string;
	stopReason?: string;
	errorMessage?: string;
}

function optionalString(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string")
		throw new Error(`${field} must be a string when present`);
	return value;
}

function optionalNumber(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		throw new Error(`${field} must be a finite non-negative number`);
	return value;
}

function parseAssistantPayload(value: unknown): AssistantPayload | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("message must be an object");
	const raw = value as Record<string, unknown>;
	if (raw.role !== "assistant") return undefined;
	if (!Array.isArray(raw.content))
		throw new Error("assistant content must be an array");
	const content = raw.content.map((part, index) => {
		if (!part || typeof part !== "object" || Array.isArray(part))
			throw new Error(`assistant content[${index}] must be an object`);
		const item = part as Record<string, unknown>;
		if (typeof item.type !== "string")
			throw new Error(`assistant content[${index}].type must be a string`);
		if (item.type === "text" && typeof item.text !== "string")
			throw new Error(`assistant content[${index}].text must be a string`);
		return item;
	});
	let usage: AssistantPayload["usage"];
	if (raw.usage !== undefined) {
		if (!raw.usage || typeof raw.usage !== "object" || Array.isArray(raw.usage))
			throw new Error("assistant usage must be an object");
		const candidate = raw.usage as Record<string, unknown>;
		let cost: { total?: number } | undefined;
		if (candidate.cost !== undefined) {
			if (
				!candidate.cost ||
				typeof candidate.cost !== "object" ||
				Array.isArray(candidate.cost)
			)
				throw new Error("assistant usage.cost must be an object");
			cost = {
				total: optionalNumber(
					(candidate.cost as Record<string, unknown>).total,
					"assistant usage.cost.total",
				),
			};
		}
		usage = {
			input: optionalNumber(candidate.input, "assistant usage.input"),
			output: optionalNumber(candidate.output, "assistant usage.output"),
			cacheRead: optionalNumber(
				candidate.cacheRead,
				"assistant usage.cacheRead",
			),
			cacheWrite: optionalNumber(
				candidate.cacheWrite,
				"assistant usage.cacheWrite",
			),
			totalTokens: optionalNumber(
				candidate.totalTokens,
				"assistant usage.totalTokens",
			),
			...(cost ? { cost } : {}),
		};
	}
	return {
		content,
		...(usage ? { usage } : {}),
		provider: optionalString(raw.provider, "assistant provider"),
		model: optionalString(raw.model, "assistant model"),
		responseModel: optionalString(raw.responseModel, "assistant responseModel"),
		stopReason: optionalString(raw.stopReason, "assistant stopReason"),
		errorMessage: optionalString(raw.errorMessage, "assistant errorMessage"),
	};
}

function finalText(message: AssistantPayload): string {
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text as string)
		.join("\n")
		.trim();
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const configured = process.env.PI_SUBAGENTS_PI_BIN?.trim();
	if (configured) return { command: configured, args };
	const script = process.argv[1];
	const bunVirtual = script?.startsWith("/$bunfs/root/");
	if (script && !bunVirtual && fs.existsSync(script))
		return { command: process.execPath, args: [script, ...args] };
	const executable = path.basename(process.execPath).toLowerCase();
	if (!/^(node|nodejs|bun)(\.exe)?$/.test(executable))
		return { command: process.execPath, args };
	return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

function processGroupAlive(pid: number): boolean {
	try {
		process.kill(-pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

function waitForGraceOrLeaderClose(
	processHandle: ChildProcess,
	pid: number,
	timeoutMs: number,
): Promise<void> {
	if (
		!processGroupAlive(pid) ||
		processHandle.exitCode !== null ||
		processHandle.signalCode !== null
	)
		return Promise.resolve();
	return new Promise((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearInterval(poll);
			clearTimeout(timeout);
			processHandle.removeListener("close", finish);
			resolve();
		};
		const poll = setInterval(() => {
			if (!processGroupAlive(pid)) finish();
		}, 20);
		const timeout = setTimeout(finish, timeoutMs);
		processHandle.once("close", finish);
	});
}

function waitForProcessGroupGone(
	pid: number,
	timeoutMs: number,
): Promise<boolean> {
	if (!processGroupAlive(pid)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const startedAt = Date.now();
		const poll = () => {
			if (!processGroupAlive(pid)) return resolve(true);
			if (Date.now() - startedAt >= timeoutMs) return resolve(false);
			setTimeout(poll, 20);
		};
		setTimeout(poll, 20);
	});
}

export async function terminateProcessTree(
	processHandle: ChildProcess,
	graceMs = 3000,
): Promise<void> {
	const pid = processHandle.pid;
	if (!pid) return;
	if (process.platform === "win32") {
		await new Promise<void>((resolve) => {
			const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
				windowsHide: true,
				stdio: "ignore",
			});
			killer.once("close", () => resolve());
			killer.once("error", () => resolve());
		});
		return;
	}
	const signalGroup = (signal: NodeJS.Signals): boolean => {
		try {
			process.kill(-pid, signal);
			return true;
		} catch {
			return false;
		}
	};
	if (!signalGroup("SIGTERM")) {
		try {
			processHandle.kill("SIGTERM");
		} catch {
			/* already exited */
		}
	}
	// Cooperative children should not pay the full grace period. A leader close
	// also ends the grace early so inherited descendants can be escalated.
	await waitForGraceOrLeaderClose(processHandle, pid, graceMs);
	if (processGroupAlive(pid)) signalGroup("SIGKILL");
	else if (
		processHandle.exitCode === null &&
		processHandle.signalCode === null
	) {
		try {
			processHandle.kill("SIGKILL");
		} catch {
			/* already exited */
		}
	}
	// Do not use leader closure as the final watermark: detached descendants can
	// remain in the same process group after their parent has exited.
	if (!(await waitForProcessGroupGone(pid, 3000)))
		throw new Error(`Process group ${pid} remained after SIGKILL.`);
}

function toolActivity(event: Record<string, unknown>): {
	tool?: string;
	path?: string;
	message: string;
} {
	const tool = typeof event.toolName === "string" ? event.toolName : undefined;
	const args =
		event.args && typeof event.args === "object"
			? (event.args as Record<string, unknown>)
			: {};
	const filePath =
		typeof args.path === "string"
			? args.path
			: typeof args.file_path === "string"
				? args.file_path
				: undefined;
	const command =
		typeof args.command === "string"
			? args.command.replace(/\s+/g, " ").slice(0, 100)
			: undefined;
	return {
		tool,
		path: filePath,
		message: command
			? `${tool ?? "tool"}: ${command}`
			: filePath
				? `${tool ?? "tool"}: ${filePath}`
				: (tool ?? "working"),
	};
}

export interface CliTransportOptions {
	runId: string;
	runDirectory: string;
	request: ResolvedAgentRunRequest;
	signal: AbortSignal;
	resultMaxBytes: number;
	transcriptMaxEvents: number;
	onEvent?: (event: TransportEvent) => void;
}

export async function runLegacyCliAgent(
	options: CliTransportOptions,
): Promise<TransportResult> {
	const { request } = options;
	if (!fs.existsSync(request.cwd) || !fs.statSync(request.cwd).isDirectory()) {
		throw new Error(`Child cwd is not a directory: ${request.cwd}`);
	}
	const promptPath = path.join(options.runDirectory, "system-prompt.md");
	fs.writeFileSync(promptPath, request.systemPrompt, {
		encoding: "utf8",
		mode: 0o600,
	});

	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-prompt-templates",
		"--no-themes",
	];
	if (!request.definition.inheritProjectContext)
		args.push("--no-context-files");
	// Never expose ambient skills to a child. Named skills are resolved by the
	// trusted parent and loaded additively by exact path.
	args.push("--no-skills");
	for (const skillPath of request.skillPaths ?? [])
		args.push("--skill", skillPath);
	if (request.definition.tools) {
		if (request.definition.tools.length === 0) args.push("--no-tools");
		else args.push("--tools", request.definition.tools.join(","));
	}
	const model = request.model ?? request.definition.model;
	const thinking = request.thinking ?? request.definition.thinking;
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	args.push(
		request.definition.systemPromptMode === "append"
			? "--append-system-prompt"
			: "--system-prompt",
		promptPath,
	);
	args.push(`Task: ${request.task}`);

	const invocation = piInvocation(args);
	const usage = emptyUsage();
	const transcript: string[] = [];
	const stderr = createByteTail();
	let child: ChildProcess | undefined;
	let termination: Promise<void> | undefined;
	const terminateChild = () => {
		if (child) termination ??= terminateProcessTree(child);
	};
	let timedOut = false;
	let maxTurnsExceeded = false;
	let cancelled = false;
	let protocolError: RunError | undefined;
	let modelName = model;
	let stopError: string | undefined;
	let authoritativeOutput = "";
	let sawAuthoritativeFinal = false;
	let sawSettled = false;
	let settlementHadFinal = false;

	const remember = (line: string) => {
		transcript.push(line);
		if (transcript.length > options.transcriptMaxEvents)
			transcript.splice(0, transcript.length - options.transcriptMaxEvents);
	};

	const childEnv = { ...process.env };
	for (const key of [
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
	])
		delete childEnv[key];

	const exitCode = await new Promise<number>((resolve) => {
		let resolved = false;
		const finish = (code: number) => {
			if (resolved) return;
			resolved = true;
			resolve(code);
		};
		child = spawn(invocation.command, invocation.args, {
			cwd: request.cwd,
			detached: process.platform !== "win32",
			windowsHide: true,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env: {
				...childEnv,
				PI_SUBAGENT_DEPTH: "1",
				PI_SUBAGENT_PARENT_RUN: options.runId,
			},
		});
		options.onEvent?.({ type: "started", data: { pid: child.pid } });

		const reader = createLineReader({
			onLine(line) {
				if (!line.trim()) return;
				let event: Record<string, unknown>;
				try {
					event = JSON.parse(line) as Record<string, unknown>;
				} catch {
					remember(`protocol: ignored malformed JSON (${line.slice(0, 200)})`);
					return;
				}
				const type = typeof event.type === "string" ? event.type : "unknown";
				if (type === "tool_execution_start") {
					const activity = toolActivity(event);
					remember(`tool: ${activity.message}`);
					options.onEvent?.({ type: "activity", data: activity });
				}
				if (type === "auto_retry_start") {
					const attempt = Number(event.attempt ?? 0);
					const maxAttempts = Number(event.maxAttempts ?? 0);
					const delayMs = Number(event.delayMs ?? 0);
					const errorMessage =
						typeof event.errorMessage === "string"
							? event.errorMessage
							: "Transient provider error";
					remember(
						`retry: ${attempt}/${maxAttempts} in ${delayMs}ms: ${errorMessage}`,
					);
					options.onEvent?.({
						type: "retry",
						data: {
							attempt,
							maxAttempts,
							delayMs,
							errorMessage,
							scope: "provider",
						},
					});
				}
				if (type === "auto_retry_end") {
					remember(
						`retry: ${event.success === true ? "recovered" : "exhausted"}${typeof event.finalError === "string" ? `: ${event.finalError}` : ""}`,
					);
				}
				if (type === "message_end") {
					let assistant: AssistantPayload | undefined;
					try {
						assistant = parseAssistantPayload(event.message);
					} catch (error) {
						const reason =
							error instanceof Error ? error.message : String(error);
						protocolError = {
							code: "malformed_message_end",
							message: `Malformed assistant message_end: ${reason}.`,
							retryable: false,
						};
						remember(`protocol: ${protocolError.message}`);
						options.onEvent?.({
							type: "protocol_error",
							data: {
								code: protocolError.code,
								message: protocolError.message,
							},
						});
						terminateChild();
					}
					if (assistant) {
						usage.turns++;
						if (assistant.usage) {
							usage.input += assistant.usage.input ?? 0;
							usage.output += assistant.usage.output ?? 0;
							usage.cacheRead += assistant.usage.cacheRead ?? 0;
							usage.cacheWrite += assistant.usage.cacheWrite ?? 0;
							usage.cost += assistant.usage.cost?.total ?? 0;
							usage.contextTokens =
								assistant.usage.totalTokens ?? usage.contextTokens;
						}
						const selectedModel = qualifiedModel(
							assistant.provider,
							assistant.model,
						);
						const responseModel = qualifiedModel(
							assistant.provider,
							assistant.responseModel,
						);
						if (
							model &&
							selectedModel &&
							!sameSelectedModel(model, selectedModel)
						) {
							protocolError = {
								code: "model_mismatch",
								message: `Requested child model ${model}, but Pi reported ${selectedModel}.`,
								retryable: false,
							};
							options.onEvent?.({
								type: "protocol_error",
								data: {
									code: protocolError.code,
									expectedModel: model,
									reportedModel: selectedModel,
								},
							});
							terminateChild();
						}
						modelName = responseModel ?? selectedModel ?? modelName;
						if (assistant.stopReason === "error")
							stopError =
								assistant.errorMessage ?? "The model reported an error.";
						else stopError = undefined;
						const text = finalText(assistant);
						const terminalAssistant =
							assistant.stopReason === "stop" ||
							assistant.stopReason === "end" ||
							assistant.stopReason === "length";
						sawAuthoritativeFinal = terminalAssistant && Boolean(text);
						if (terminalAssistant) authoritativeOutput = text;
						if (text) remember(`assistant: ${text.slice(0, 500)}`);
						options.onEvent?.({
							type: "usage",
							data: {
								...usage,
								model: modelName,
								selectedModel,
								responseModel,
								thinking,
							},
						});
						const terminalStop =
							assistant.stopReason === "stop" || assistant.stopReason === "end";
						if (usage.turns >= request.maxTurns && !terminalStop && child) {
							maxTurnsExceeded = true;
							terminateChild();
						}
					}
				}
				if (type === "agent_settled") {
					sawSettled = true;
					settlementHadFinal = sawAuthoritativeFinal;
					options.onEvent?.({ type: "settled" });
				}
			},
			onLimit(error) {
				protocolError = {
					code: error.code,
					message: `Child JSON event exceeded ${error.limitBytes} bytes.`,
					retryable: false,
				};
				options.onEvent?.({ type: "protocol_error", data: { ...error } });
				terminateChild();
			},
		});

		child.stdout?.on("data", (chunk: Buffer) => reader.push(chunk));
		child.stdout?.on("end", () => reader.end());
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr.push(chunk);
			options.onEvent?.({ type: "stderr", data: { bytes: chunk.length } });
		});
		child.once("error", (error) => {
			stopError = `Failed to spawn Pi child: ${error.message}`;
			finish(1);
		});
		child.once("close", (code) => finish(code ?? 1));

		const timeout = setTimeout(() => {
			timedOut = true;
			terminateChild();
		}, request.timeoutMs);
		timeout.unref?.();

		const abort = () => {
			cancelled = true;
			terminateChild();
		};
		if (options.signal.aborted) abort();
		else options.signal.addEventListener("abort", abort, { once: true });
		void new Promise<void>((done) =>
			child?.once("close", () => done()),
		).finally(() => {
			clearTimeout(timeout);
			options.signal.removeEventListener("abort", abort);
		});
	});
	if (termination) await termination;

	const fullOutput = authoritativeOutput;
	const bounded = truncateUtf8(fullOutput, options.resultMaxBytes);
	let state: TransportResult["state"] = "succeeded";
	let error: RunError | undefined;
	if (cancelled) {
		state = "cancelled";
		error = {
			code: "cancelled",
			message: "The subagent was cancelled.",
			retryable: false,
		};
	} else if (timedOut) {
		state = "timed_out";
		error = {
			code: "timeout",
			message: `The subagent exceeded ${request.timeoutMs} ms.`,
			retryable: false,
		};
	} else if (maxTurnsExceeded) {
		state = "failed";
		error = {
			code: "max_turns",
			message: `The subagent exceeded ${request.maxTurns} assistant turns.`,
			retryable: false,
		};
	} else if (protocolError) {
		state = "failed";
		error = protocolError;
	} else if (exitCode !== 0 || stopError) {
		state = "failed";
		const message =
			stopError ??
			(stderr.text().trim() || `Pi child exited with code ${exitCode}.`);
		error = {
			code: stopError ? "model_or_spawn_error" : "child_exit",
			message,
			retryable: isTransientTransportError(message),
		};
	} else if (!sawSettled || !settlementHadFinal) {
		state = "failed";
		error = {
			code: "incomplete_child_protocol",
			message: !sawSettled
				? "Pi child exited successfully without an agent_settled watermark."
				: "Pi child settled without an authoritative final assistant result.",
			retryable: false,
		};
	}

	return {
		state,
		output: bounded.text,
		fullOutput,
		usage,
		model: modelName,
		pid: child?.pid,
		error,
		stderr: stderr.text(),
		transcript,
		truncated: bounded.truncated,
	};
}

/** Explicit CLI override preserves integrations; normal runs use the isolated SDK host. */
export async function runCliAgent(
	options: CliTransportOptions,
): Promise<TransportResult> {
	if (process.env.PI_SUBAGENTS_PI_BIN?.trim())
		return runLegacyCliAgent(options);
	const { runSdkAgent } = await import("./sdk-transport.ts");
	return runSdkAgent(options);
}
