import * as path from "node:path";
import { clampThinkingLevel, StringEnum } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildChildSystemPrompt, discoverAgents } from "./agents.ts";
import { loadConfig } from "./config.ts";
import { getRuntime } from "./runtime.ts";
import type {
	AgentDefinition,
	ContextMode,
	ResolvedAgentRunRequest,
	RunRecord,
	SubagentToolDetails,
	WorkspaceMode,
} from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";
import {
	closeFleet,
	installUiProjection,
	openFleet,
	renderControlCall,
	renderControlResult,
	renderRunCall,
	renderRunResult,
} from "./ui.ts";
import { discoverWorkflows, getWorkflowEngine } from "./workflows.ts";

const ThinkingSchema = StringEnum([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const);
const ContextSchema = StringEnum(["fresh", "summary"] as const);
const WorkspaceSchema = StringEnum(["shared", "worktree"] as const);
const AgentScopeSchema = StringEnum(["user", "project", "both"] as const, {
	description:
		"Agent discovery scope. Defaults to both for trusted projects and user otherwise.",
});
const STATUS_ACTIVATION_EVENT = "pi-ui-customization:activate-status";
const STATUS_OPTIONS_EVENT = "pi-ui-customization:status-options";
const STATUS_KEY = "pi-subagents";

type StatusActivation = {
	key?: unknown;
	sessionId?: unknown;
};

const SubagentRunParams = Type.Object({
	agent: Type.String({
		description:
			"Descriptive name for this child run, such as task-auditor or api-scout. May also be an exact discovered agent name.",
		pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$",
	}),
	baseAgent: Type.Optional(
		Type.String({
			description:
				"Exact discovered agent definition whose prompt and tools this named child should use. Omit to use an exact agent-name match, then the general role as fallback.",
		}),
	),
	task: Type.String({ description: "Focused task delegated to the child" }),
	background: Type.Optional(
		Type.Boolean({
			description: "Return immediately and continue in the background",
		}),
	),
	context: Type.Optional(ContextSchema),
	model: Type.Optional(
		Type.String({
			description:
				"Exact provider/model override. Omit this to inherit the parent's current model; never invent a model name.",
		}),
	),
	thinking: Type.Optional(ThinkingSchema),
	cwd: Type.Optional(
		Type.String({
			description:
				"Child working directory, relative to the current cwd or absolute",
		}),
	),
	workspace: Type.Optional(WorkspaceSchema),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Optional hard wall-clock ceiling in milliseconds. Omit to inherit the agent/config default; avoid short ad hoc timeouts for repository-scale tasks.",
		}),
	),
	maxTurns: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"Optional hard assistant-turn ceiling. Omit to inherit the agent/config default; do not guess a low cap for broad or long-running work.",
		}),
	),
	maxRetries: Type.Optional(
		Type.Integer({
			minimum: 0,
			maximum: 5,
			description:
				"Whole-child retries after Pi exhausts its own transient-error retries. Defaults to extension configuration.",
		}),
	),
	agentScope: Type.Optional(AgentScopeSchema),
	confirmProjectAgent: Type.Optional(
		Type.Boolean({
			description:
				"Prompt before executing a project-local agent; defaults to true",
		}),
	),
});

const ControlParams = Type.Object({
	action: StringEnum([
		"list",
		"status",
		"wait",
		"send",
		"interrupt",
		"stop",
	] as const),
	runId: Type.Optional(
		Type.String({ description: "Full run id or unambiguous prefix" }),
	),
	message: Type.Optional(
		Type.String({
			description: "Message for send (stateful transport is not yet available)",
		}),
	),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"How long to observe this wait before returning the current state; the run continues after the window ends",
		}),
	),
});

const WorkflowRunParams = Type.Object({
	workflow: Type.String(),
	input: Type.Unknown({
		description: "Workflow input, commonly a string or { request: string }",
	}),
	background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately and continue the workflow in the background",
		}),
	),
	preview: Type.Optional(
		Type.Boolean({ description: "Show a confirmation preview before launch" }),
	),
});

const WorkflowControlParams = Type.Object({
	action: StringEnum(["list", "status", "wait", "stop", "resume"] as const),
	runId: Type.Optional(Type.String()),
	timeoutMs: Type.Optional(
		Type.Integer({
			minimum: 1,
			description:
				"How long to observe this wait before returning the current state; the workflow continues after the window ends",
		}),
	),
});

function textFromMessage(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const candidate = message as { role?: unknown; content?: unknown };
	if (candidate.role !== "user" && candidate.role !== "assistant") return "";
	if (typeof candidate.content === "string")
		return `${candidate.role}: ${candidate.content}`;
	if (!Array.isArray(candidate.content)) return "";
	const text = candidate.content
		.filter((part): part is { type: "text"; text: string } =>
			Boolean(
				part &&
					typeof part === "object" &&
					(part as { type?: unknown }).type === "text" &&
					typeof (part as { text?: unknown }).text === "string",
			),
		)
		.map((part) => part.text)
		.join("\n");
	return text ? `${candidate.role}: ${text}` : "";
}

function parentSummary(ctx: ExtensionContext, maxChars = 12_000): string {
	const lines: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const text = textFromMessage(entry.message);
		if (text) lines.push(text);
	}
	let result = lines.slice(-20).join("\n\n");
	if (result.length > maxChars)
		result = `[Earlier parent context omitted]\n${result.slice(-maxChars)}`;
	return result;
}

function selectedModel(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function canonicalModelSpec(
	ctx: ExtensionContext,
	requested: string | undefined,
): string | undefined {
	if (!requested) return selectedModel(ctx);
	const separator = requested.indexOf("/");
	if (separator > 0) {
		const provider = requested.slice(0, separator);
		const modelId = requested.slice(separator + 1);
		if (ctx.modelRegistry.find(provider, modelId)) return requested;
		throw new Error(
			`Unknown child model '${requested}'. Use an exact available provider/model identifier.`,
		);
	}
	const matches = ctx.modelRegistry
		.getAvailable()
		.filter((model) => model.id === requested);
	const currentProviderMatch = matches.find(
		(model) => model.provider === ctx.model?.provider,
	);
	const match =
		currentProviderMatch ?? (matches.length === 1 ? matches[0] : undefined);
	if (match) return `${match.provider}/${match.id}`;
	if (matches.length > 1)
		throw new Error(
			`Ambiguous child model '${requested}'. Use an exact provider/model identifier.`,
		);
	throw new Error(
		`Unknown child model '${requested}'. Use an exact available provider/model identifier.`,
	);
}

function shortModel(model: string | undefined): string {
	return model?.split("/").at(-1) ?? "default";
}

function effectiveThinking(
	ctx: ExtensionContext,
	modelSpec: string | undefined,
	thinking: ResolvedAgentRunRequest["thinking"],
): ResolvedAgentRunRequest["thinking"] {
	if (!thinking) return undefined;
	let model =
		!modelSpec || modelSpec === selectedModel(ctx) ? ctx.model : undefined;
	if (modelSpec) {
		const separator = modelSpec.indexOf("/");
		if (separator > 0)
			model =
				ctx.modelRegistry.find(
					modelSpec.slice(0, separator),
					modelSpec.slice(separator + 1),
				) ?? model;
	}
	return model ? clampThinkingLevel(model, thinking) : thinking;
}

function resolveRequest(
	params: {
		agent: string;
		baseAgent?: string;
		task: string;
		background?: boolean;
		context?: ContextMode;
		model?: string;
		thinking?: ResolvedAgentRunRequest["thinking"];
		cwd?: string;
		workspace?: WorkspaceMode;
		timeoutMs?: number;
		maxTurns?: number;
		maxRetries?: number;
	},
	definition: AgentDefinition,
	ctx: ExtensionContext,
	parentThinking: ResolvedAgentRunRequest["thinking"],
): ResolvedAgentRunRequest {
	const context = params.context ?? definition.context;
	const contextText = context === "summary" ? parentSummary(ctx) : "";
	const task = contextText
		? `${params.task}\n\n<parent_context>\n${contextText}\n</parent_context>`
		: params.task;
	const model = canonicalModelSpec(ctx, params.model ?? definition.model);
	const thinking = effectiveThinking(
		ctx,
		model,
		params.thinking ?? definition.thinking ?? parentThinking,
	);
	const timeoutMs = params.timeoutMs ?? definition.timeoutMs;
	const maxTurns = params.maxTurns ?? definition.maxTurns;
	const systemPrompt = buildChildSystemPrompt(definition, {
		runName: params.agent,
		maxTurns,
		timeoutMs,
	});
	return {
		agent: params.agent,
		baseAgent: params.agent === definition.name ? undefined : definition.name,
		task,
		definition,
		background: params.background ?? false,
		context,
		model,
		thinking,
		cwd: params.cwd ? path.resolve(ctx.cwd, params.cwd) : ctx.cwd,
		workspace: params.workspace ?? definition.workspace,
		timeoutMs,
		maxTurns,
		maxRetries: params.maxRetries,
		systemPrompt,
	};
}

function formatRun(record: RunRecord): string {
	const name = record.agent ?? record.workflow ?? record.kind;
	const attempts =
		typeof record.metadata?.attempt === "number" && record.metadata.attempt > 1
			? `${record.metadata.attempt} attempts`
			: undefined;
	const selection = [
		attempts,
		record.model ? shortModel(record.model) : undefined,
		record.thinking ? `${record.thinking} effort` : undefined,
		record.usage.cost ? `$${record.usage.cost.toFixed(4)}` : undefined,
	].filter((part): part is string => Boolean(part));
	const details = selection.length ? ` · ${selection.join(" · ")}` : "";
	const output = record.output
		? `\n\n${record.output}`
		: record.error
			? `\n\n${record.error.message}`
			: "";
	return `${name} ${record.state} [${record.id}]${details}${output}`;
}

function formatWaitResult(record: RunRecord): string {
	if (TERMINAL_STATES.has(record.state)) return formatRun(record);
	return `Wait window ended; ${record.agent ?? record.workflow ?? record.kind} is still ${record.state} [${record.id}] and continues in the background. Use status or wait again only when its result is needed.`;
}

function requireRunId(value: string | undefined, action: string): string {
	if (!value) throw new Error(`${action} requires runId.`);
	return value;
}

export default function (pi: ExtensionAPI) {
	const runtime = getRuntime();
	const workflowEngine = getWorkflowEngine(runtime);
	const observedRuns = new Set<string>();
	let uninstallUi: (() => void) | undefined;
	let uninstallStatusActivation: (() => void) | undefined;
	let uiSessionId: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		pi.events.emit(STATUS_OPTIONS_EVENT, {
			key: STATUS_KEY,
			preserveSelectedColors: true,
		});
		if (uiSessionId) closeFleet(runtime, uiSessionId);
		uiSessionId = ctx.sessionManager.getSessionId();
		runtime.configure(loadConfig(ctx.cwd, ctx.isProjectTrusted()));
		uninstallUi?.();
		uninstallUi = installUiProjection(ctx, runtime, observedRuns);
		uninstallStatusActivation?.();
		uninstallStatusActivation = pi.events.on(
			STATUS_ACTIVATION_EVENT,
			(data) => {
				const activation = data as StatusActivation;
				if (
					activation.key !== STATUS_KEY ||
					activation.sessionId !== ctx.sessionManager.getSessionId()
				)
					return;
				void openFleet(ctx, runtime).catch((error) =>
					ctx.ui.notify(
						error instanceof Error ? error.message : String(error),
						"error",
					),
				);
			},
		);
	});

	pi.on("session_shutdown", (event) => {
		if (uiSessionId) closeFleet(runtime, uiSessionId);
		uiSessionId = undefined;
		uninstallUi?.();
		uninstallUi = undefined;
		uninstallStatusActivation?.();
		uninstallStatusActivation = undefined;
		if (event.reason === "quit") runtime.shutdown();
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!pi.getActiveTools().includes("subagent_run")) return;
		const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		const scope = ctx.isProjectTrusted() ? "both" : "user";
		const agents = discoverAgents({
			cwd: ctx.cwd,
			projectTrusted: ctx.isProjectTrusted(),
			scope,
			config,
		});
		const catalog = agents
			.map((agent) => `- ${agent.name}: ${agent.description}`)
			.join("\n");
		return {
			systemPrompt: `${event.systemPrompt}\n\n<available_subagents>\nGive each subagent_run a concise descriptive agent name. To specialize it, set baseAgent to one of these exact definitions:\n${catalog || "- (none)"}\nIf baseAgent is omitted, an agent name matching a definition uses that definition; otherwise it uses general. Omit subagent_run.model unless the user explicitly requests an exact provider/model override. When omitted, the child inherits ${selectedModel(ctx) ?? "the parent model"}. Omit maxTurns and timeoutMs unless the user requests hard ceilings; built-in defaults support long-running work.\n</available_subagents>`,
		};
	});

	pi.registerTool({
		name: "subagent_run",
		label: "Subagent",
		description:
			"Run one focused, descriptively named child Pi agent with an isolated context. Set baseAgent to a discovered definition such as scout, planner, reviewer, or worker when specialization helps; otherwise the general role is used. To parallelize independent work, emit multiple subagent_run calls together in the same assistant message; Pi executes sibling tool calls concurrently while the extension enforces a global limit. Prefer 2-4 read-only children. Omit maxTurns and timeoutMs unless the user intentionally requests hard ceilings; built-in defaults are designed for long-running work. Do not delegate trivial work or run concurrent shared-workspace writers. Use a programmatic workflow for large dynamic fan-out.",
		promptSnippet:
			"Run one isolated specialist child in the foreground or background; multiple sibling calls run concurrently",
		promptGuidelines: [
			"Give subagent_run agent a concise task-specific name. Set baseAgent to an exact discovered role when its specialization helps; omit baseAgent to use an exact agent-name match or the general fallback.",
			"Omit subagent_run model by default so the child inherits the parent's current provider/model; never invent a model override.",
			"Omit subagent_run maxTurns and timeoutMs unless the user explicitly requests a hard cap. Built-in agents already allow 128 turns and one hour; low ad hoc caps can terminate broad investigations before they produce a handoff.",
			"Proactively consider subagent_run when context isolation, independent review, specialization, or real parallelism would improve the result enough to justify child startup cost.",
			"For independent parallel tasks, issue multiple subagent_run calls in the same assistant message; do not call them sequentially.",
			"Set subagent_run background=true when its result is not needed on the immediate critical path. The launch returns immediately: continue useful independent parent work, or end the turn and rely on the completion notification; use subagent_control status/wait later only when the result is needed, and do not poll.",
			"Background subagent_run work survives parent turns, session switches, and extension reloads in the current Pi process, but a full Pi process exit stops it.",
			"Do not use subagent_run for trivial known-file edits or as a way to wait on ordinary critical-path work.",
			"Never run concurrent write-capable subagent_run calls in a shared workspace; select worktree isolation or serialize them.",
		],
		parameters: SubagentRunParams,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			runtime.configure(config);
			const scope =
				params.agentScope ?? (ctx.isProjectTrusted() ? "both" : "user");
			if (
				(scope === "project" || scope === "both") &&
				!ctx.isProjectTrusted()
			) {
				throw new Error(
					`Project-local agents require a trusted project (${CONFIG_DIR_NAME}/agents).`,
				);
			}
			const agents = discoverAgents({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				scope,
				config,
			});
			const requestedBase = params.baseAgent ?? params.agent;
			const exactDefinition = agents.find(
				(agent) => agent.name === requestedBase,
			);
			const definition =
				exactDefinition ??
				(!params.baseAgent
					? agents.find((agent) => agent.name === "general")
					: undefined);
			if (!definition)
				throw new Error(
					`Unknown base agent '${requestedBase}'. Available: ${agents.map((agent) => agent.name).join(", ") || "none"}.`,
				);
			if (
				definition.source === "project" &&
				(params.confirmProjectAgent ?? config.confirmProjectAgents) &&
				ctx.hasUI
			) {
				const approved = await ctx.ui.confirm(
					"Run project-local agent?",
					`${definition.name}\n${definition.description}\n\nSource: ${definition.filePath}\n\nProject prompts are repository-controlled.`,
				);
				if (!approved) throw new Error("Project-local agent was not approved.");
			}
			const request = resolveRequest(
				params,
				definition,
				ctx,
				pi.getThinkingLevel(),
			);
			let activeRunId: string | undefined;
			const unsubscribe = runtime.subscribe((update) => {
				if (update.run.id !== activeRunId) return;
				onUpdate?.({
					content: [{ type: "text", text: formatRun(update.run) }],
					details: {
						run: update.run,
						recentActivity: runtime.getActivities(update.run.id),
					} satisfies SubagentToolDetails,
				});
			});
			const abortController = new AbortController();
			const abort = () =>
				abortController.abort(
					signal?.reason ?? new Error("Parent turn aborted"),
				);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			try {
				const record = await runtime.startAgent(request, {
					background: request.background,
					sessionId: ctx.sessionManager.getSessionId(),
					signal: request.background ? undefined : abortController.signal,
					onCreated: (created) => {
						activeRunId = created.id;
					},
				});
				return {
					content: [
						{
							type: "text",
							text: record.background
								? `${request.background ? "Started" : "Moved"} ${record.agent} to the background [${record.id}]. Continue useful independent work, end the turn and rely on notifications, or use subagent_control wait/status when its result is required.`
								: formatRun(record),
						},
					],
					details: {
						run: record,
						recentActivity: runtime.getActivities(record.id),
					} satisfies SubagentToolDetails,
				};
			} finally {
				unsubscribe();
				signal?.removeEventListener("abort", abort);
			}
		},
		renderCall(args, theme) {
			return renderRunCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderRunResult(result, options, theme, {
				lastComponent: context.lastComponent,
				invalidate: context.invalidate,
				resolveRun: (runId) => runtime.get(runId),
			});
		},
	});

	pi.registerTool({
		name: "subagent_control",
		label: "Subagent Control",
		description:
			"List, inspect, wait for, interrupt, or stop subagent runs. Status is a one-shot inspection, not a polling loop. Stateful send is reserved for a future persistent transport.",
		parameters: ControlParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "list") {
				const runs = runtime
					.listForSession(sessionId, 30)
					.filter((run) => run.kind === "agent");
				return {
					content: [
						{
							type: "text",
							text: runs.length
								? runs
										.map(
											(run) =>
												`${run.id}  ${run.state.padEnd(11)}  ${run.agent ?? run.workflow ?? run.kind}`,
										)
										.join("\n")
								: "No subagent runs.",
						},
					],
					details: { runs },
				};
			}
			if (params.action === "send")
				throw new Error(
					"subagent_control send requires the planned persistent RPC/SDK transport and is not available yet. Start a new child with selected context instead.",
				);
			const id = requireRunId(params.runId, params.action);
			if (params.action === "status") {
				const run = runtime.getForSession(id, sessionId);
				if (run?.kind !== "agent") throw new Error(`Run not found: ${id}`);
				return {
					content: [{ type: "text", text: formatRun(run) }],
					details: { runs: [run] },
				};
			}
			if (params.action === "wait") {
				const pending = runtime.getForSession(id, sessionId);
				if (pending?.kind !== "agent") throw new Error(`Run not found: ${id}`);
				observedRuns.add(pending.id);
				try {
					const run = await runtime.wait(pending.id, params.timeoutMs, signal);
					return {
						content: [{ type: "text", text: formatWaitResult(run) }],
						details: { runs: [run] },
					};
				} finally {
					observedRuns.delete(pending.id);
				}
			}
			const pending = runtime.getForSession(id, sessionId);
			if (pending?.kind !== "agent") throw new Error(`Run not found: ${id}`);
			const run = runtime.stop(
				pending.id,
				params.action === "interrupt"
					? "Interrupted by user"
					: "Stopped by user",
			);
			return {
				content: [
					{ type: "text", text: `${params.action} requested for ${run.id}.` },
				],
				details: { runs: [run] },
			};
		},
		renderCall(args, theme) {
			return renderControlCall("subagent", args, theme);
		},
		renderResult(result, options, theme) {
			return renderControlResult(result, options, theme);
		},
	});

	pi.registerTool({
		name: "workflow_run",
		label: "Workflow",
		description:
			"Run a named programmatic TypeScript workflow in the foreground or background. Workflows may dynamically fan out to many bounded child agents and join results. Use this instead of manually coordinating large fleets.",
		promptSnippet:
			"Run a bounded programmatic multi-agent workflow in the foreground or background",
		promptGuidelines: [
			"Proactively consider workflow_run for repeatable multi-step work, dynamic fan-out, or more than four child tasks.",
			"Set workflow_run background=true for long-running workflows whose result is not needed on the immediate critical path. The launch returns immediately: continue useful independent parent work, or end the turn and rely on the completion notification; use workflow_control status/wait later only when needed, and do not poll.",
			"Background workflow_run work survives parent turns, session switches, and extension reloads in the current Pi process, but a full Pi process exit stops it.",
		],
		parameters: WorkflowRunParams,
		async execute(_id, params, signal, onUpdate, ctx) {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			runtime.configure(config);
			const workflows = await discoverWorkflows(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			const workflow = workflows.find(
				(candidate) => candidate.definition.name === params.workflow,
			);
			if (!workflow)
				throw new Error(
					`Unknown workflow '${params.workflow}'. Available: ${workflows.map((item) => item.definition.name).join(", ") || "none"}.`,
				);
			const agents = discoverAgents({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				scope: ctx.isProjectTrusted() ? "both" : "user",
				config,
			});
			const projectAgents = agents.filter(
				(agent) => agent.source === "project",
			);
			const shouldPreview =
				params.preview === true ||
				(workflow.source === "project" && config.confirmProjectWorkflows) ||
				(projectAgents.length > 0 && config.confirmProjectAgents);
			if (shouldPreview && ctx.hasUI) {
				const details = [
					`${workflow.definition.name}: ${workflow.definition.description}`,
					`Source: ${workflow.filePath}`,
					`Mode: ${params.background ? "background" : "foreground"}`,
					projectAgents.length
						? `Project agent overrides available: ${projectAgents.map((agent) => agent.name).join(", ")}`
						: undefined,
					workflow.source === "project"
						? "WARNING: this project-local TypeScript workflow executes as trusted local code."
						: undefined,
				]
					.filter((line): line is string => Boolean(line))
					.join("\n");
				if (!(await ctx.ui.confirm("Launch workflow?", details)))
					throw new Error("Workflow launch was not approved.");
			}
			let parentId: string | undefined;
			const unsubscribe = runtime.subscribe((update) => {
				if (update.run.id !== parentId) return;
				onUpdate?.({
					content: [{ type: "text", text: formatRun(update.run) }],
					details: { run: update.run } satisfies SubagentToolDetails,
				});
			});
			const abortController = new AbortController();
			const abort = () =>
				abortController.abort(
					signal?.reason ?? new Error("Parent turn aborted"),
				);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			try {
				const record = await workflowEngine.start(workflow, params.input, {
					cwd: ctx.cwd,
					sessionId: ctx.sessionManager.getSessionId(),
					background: params.background ?? false,
					defaultModel: selectedModel(ctx),
					defaultThinking: pi.getThinkingLevel(),
					resolveThinking: (model, thinking) =>
						effectiveThinking(ctx, model, thinking),
					resolveAgent: (name) => agents.find((agent) => agent.name === name),
					signal: params.background ? undefined : abortController.signal,
					onCreated: (created) => {
						parentId = created.id;
					},
				});
				parentId = record.id;
				return {
					content: [
						{
							type: "text",
							text: params.background
								? `Started workflow ${record.workflow} in the background [${record.id}]. Continue useful independent work, end the turn and rely on notifications, or use workflow_control wait/status when its result is required.`
								: formatRun(record),
						},
					],
					details: { run: record } satisfies SubagentToolDetails,
				};
			} finally {
				unsubscribe();
				signal?.removeEventListener("abort", abort);
			}
		},
		renderCall(args, theme) {
			return renderRunCall(args, theme);
		},
		renderResult(result, options, theme, context) {
			return renderRunResult(result, options, theme, {
				lastComponent: context.lastComponent,
				invalidate: context.invalidate,
				resolveRun: (runId) => runtime.get(runId),
			});
		},
	});

	pi.registerTool({
		name: "workflow_control",
		label: "Workflow Control",
		description:
			"List, inspect, wait for, stop, or resume programmatic workflow runs.",
		parameters: WorkflowControlParams,
		async execute(_id, params, signal, _onUpdate, ctx) {
			const sessionId = ctx.sessionManager.getSessionId();
			if (params.action === "list") {
				const runs = runtime
					.listForSession(sessionId, 50)
					.filter((run) => run.kind === "workflow");
				return {
					content: [
						{
							type: "text",
							text: runs.length
								? runs
										.map(
											(run) =>
												`${run.id}  ${run.state.padEnd(11)}  ${run.workflow}`,
										)
										.join("\n")
								: "No workflow runs.",
						},
					],
					details: { runs },
				};
			}
			const id = requireRunId(params.runId, params.action);
			if (params.action === "status") {
				const run = runtime.getForSession(id, sessionId);
				if (run?.kind !== "workflow")
					throw new Error(`Workflow run not found: ${id}`);
				const snapshot = runtime.store.readWorkflow(run.id);
				const steps = snapshot
					? Object.values(snapshot.steps)
							.map(
								(step) =>
									`${step.state === "succeeded" ? "✓" : step.state === "running" ? "●" : step.state === "queued" ? "◦" : "✗"} ${step.id} (${step.kind}) ${step.state}`,
							)
							.join("\n")
					: "(workflow snapshot unavailable)";
				return {
					content: [{ type: "text", text: `${formatRun(run)}\n\n${steps}` }],
					details: { runs: [run] },
				};
			}
			if (params.action === "wait") {
				const pending = runtime.getForSession(id, sessionId);
				if (pending?.kind !== "workflow")
					throw new Error(`Workflow run not found: ${id}`);
				observedRuns.add(pending.id);
				try {
					const run = await workflowEngine.wait(
						pending.id,
						params.timeoutMs,
						signal,
					);
					return {
						content: [{ type: "text", text: formatWaitResult(run) }],
						details: { runs: [run] },
					};
				} finally {
					observedRuns.delete(pending.id);
				}
			}
			if (params.action === "stop") {
				const pending = runtime.getForSession(id, sessionId);
				if (pending?.kind !== "workflow")
					throw new Error(`Workflow run not found: ${id}`);
				const run = workflowEngine.stop(pending.id);
				return {
					content: [{ type: "text", text: `Stop requested for ${run.id}.` }],
					details: { runs: [run] },
				};
			}
			const previous = runtime.getForSession(id, sessionId);
			if (previous?.kind !== "workflow")
				throw new Error(`Workflow run not found: ${id}`);
			if (!TERMINAL_STATES.has(previous.state) && previous.state !== "paused")
				throw new Error(
					`Workflow ${previous.id} is ${previous.state}; it does not need resume.`,
				);
			const workflows = await discoverWorkflows(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			const workflow = workflows.find(
				(candidate) => candidate.definition.name === previous.workflow,
			);
			if (!workflow)
				throw new Error(
					`Workflow definition no longer exists: ${previous.workflow}`,
				);
			const agents = discoverAgents({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				scope: ctx.isProjectTrusted() ? "both" : "user",
				config: loadConfig(ctx.cwd, ctx.isProjectTrusted()),
			});
			const snapshot = runtime.store.readWorkflow(previous.id);
			const resumed = await workflowEngine.start(workflow, snapshot?.input, {
				cwd: previous.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				background: true,
				defaultModel: selectedModel(ctx),
				defaultThinking: pi.getThinkingLevel(),
				resolveThinking: (model, thinking) =>
					effectiveThinking(ctx, model, thinking),
				resolveAgent: (name) => agents.find((agent) => agent.name === name),
				existingRunId: previous.id,
			});
			return {
				content: [{ type: "text", text: `Resumed workflow ${resumed.id}.` }],
				details: { runs: [resumed] },
			};
		},
		renderCall(args, theme) {
			return renderControlCall("workflow", args, theme);
		},
		renderResult(result, options, theme) {
			return renderControlResult(result, options, theme);
		},
	});

	pi.registerCommand("subagents", {
		description: "List available subagents",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const agents = discoverAgents({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				scope: ctx.isProjectTrusted() ? "both" : "user",
				config,
			});
			const parentModel = selectedModel(ctx);
			const parentThinking = pi.getThinkingLevel();
			ctx.ui.notify(
				agents
					.map((agent) => {
						const modelSpec = agent.model ?? parentModel;
						const model = shortModel(modelSpec);
						const effort = effectiveThinking(
							ctx,
							modelSpec,
							agent.thinking ?? parentThinking,
						);
						return `${agent.name} [${agent.source}] · ${model} · ${effort} effort — ${agent.description}`;
					})
					.join("\n") || "No agents found.",
				"info",
			);
		},
	});

	pi.registerCommand("subagents-fleet", {
		description: "Open the live subagent fleet inspector",
		handler: async (_args, ctx) => openFleet(ctx, runtime),
	});

	pi.registerCommand("subagents-stop", {
		description: "Stop an active subagent or workflow run",
		handler: async (args, ctx) => {
			let requested = args.trim();
			if (!requested) {
				const active = runtime
					.listForSession(ctx.sessionManager.getSessionId(), 100)
					.filter((run) => !TERMINAL_STATES.has(run.state));
				if (!active.length) return ctx.ui.notify("No active runs.", "info");
				requested =
					(await ctx.ui.select(
						"Stop which run?",
						active.map(
							(run) => `${run.id}  ${run.agent ?? run.workflow ?? run.kind}`,
						),
					)) ?? "";
				requested = requested.split(/\s+/)[0] ?? "";
			}
			if (!requested) return;
			const run = runtime.getForSession(
				requested,
				ctx.sessionManager.getSessionId(),
			);
			if (!run) return ctx.ui.notify(`Run not found: ${requested}`, "error");
			try {
				if (run.kind === "workflow") workflowEngine.stop(run.id);
				else runtime.stop(run.id);
				ctx.ui.notify(`Stop requested for ${run.id}.`, "info");
			} catch (error) {
				ctx.ui.notify(
					error instanceof Error ? error.message : String(error),
					"error",
				);
			}
		},
	});

	pi.registerCommand("workflows", {
		description: "List available programmatic workflows",
		handler: async (_args, ctx) => {
			const workflows = await discoverWorkflows(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			ctx.ui.notify(
				workflows
					.map(
						(workflow) =>
							`${workflow.definition.name} [${workflow.source}] — ${workflow.definition.description}`,
					)
					.join("\n") || "No workflows found.",
				"info",
			);
		},
	});

	pi.registerCommand("workflow-run", {
		description:
			"Run a programmatic workflow: /workflow-run <name> [--bg] <input>",
		handler: async (args, ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const name = parts.shift();
			if (!name)
				return ctx.ui.notify(
					"Usage: /workflow-run <name> [--bg] <input>",
					"warning",
				);
			const backgroundIndex = parts.indexOf("--bg");
			const background = backgroundIndex >= 0;
			if (background) parts.splice(backgroundIndex, 1);
			const input = parts.join(" ");
			if (!input)
				return ctx.ui.notify("Workflow input is required.", "warning");
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			runtime.configure(config);
			const workflows = await discoverWorkflows(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			const workflow = workflows.find(
				(candidate) => candidate.definition.name === name,
			);
			if (!workflow)
				return ctx.ui.notify(`Unknown workflow '${name}'.`, "error");
			if (
				(workflow.source === "project" || config.confirmProjectWorkflows) &&
				ctx.hasUI
			) {
				const approved = await ctx.ui.confirm(
					"Launch workflow?",
					`${workflow.definition.name}: ${workflow.definition.description}\nSource: ${workflow.filePath}\nMode: ${background ? "background" : "foreground"}`,
				);
				if (!approved) return;
			}
			const agents = discoverAgents({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				scope: ctx.isProjectTrusted() ? "both" : "user",
				config,
			});
			const record = await workflowEngine.start(workflow, input, {
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
				background,
				defaultModel: selectedModel(ctx),
				defaultThinking: pi.getThinkingLevel(),
				resolveThinking: (model, thinking) =>
					effectiveThinking(ctx, model, thinking),
				resolveAgent: (agentName) =>
					agents.find((agent) => agent.name === agentName),
			});
			ctx.ui.notify(
				`${record.workflow} ${record.state} [${record.id}]`,
				record.state === "failed" ? "error" : "info",
			);
		},
	});

	pi.registerCommand("workflow-status", {
		description: "Show workflow steps for a run",
		handler: async (args, ctx) => {
			let requested = args.trim();
			if (!requested) {
				const runs = runtime
					.listForSession(ctx.sessionManager.getSessionId(), 50)
					.filter((run) => run.kind === "workflow");
				const latest = runs[0];
				if (!latest) return ctx.ui.notify("No workflow runs.", "info");
				requested = latest.id;
			}
			const run = runtime.getForSession(
				requested,
				ctx.sessionManager.getSessionId(),
			);
			if (run?.kind !== "workflow")
				return ctx.ui.notify(`Workflow run not found: ${requested}`, "error");
			const snapshot = runtime.store.readWorkflow(run.id);
			const lines = snapshot
				? Object.values(snapshot.steps).map(
						(step) =>
							`${step.state === "succeeded" ? "✓" : step.state === "running" ? "●" : "◦"} ${step.id} · ${step.state}`,
					)
				: ["(workflow snapshot unavailable)"];
			ctx.ui.notify(
				`${run.workflow} · ${run.state}\n${lines.join("\n")}`,
				run.state === "failed" ? "error" : "info",
			);
		},
	});

	pi.registerCommand("subagents-doctor", {
		description: "Check subagent configuration and runtime health",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd, ctx.isProjectTrusted());
			const agents = discoverAgents({
				cwd: ctx.cwd,
				projectTrusted: ctx.isProjectTrusted(),
				scope: ctx.isProjectTrusted() ? "both" : "user",
				config,
			});
			const workflows = await discoverWorkflows(
				ctx.cwd,
				ctx.isProjectTrusted(),
			);
			const stale = runtime
				.listForSession(ctx.sessionManager.getSessionId(), 500)
				.filter((run) => run.state === "orphaned").length;
			const lines = [
				`Project trusted: ${ctx.isProjectTrusted() ? "yes" : "no"}`,
				`Agents: ${agents.length} (${agents.map((agent) => agent.name).join(", ")})`,
				`Workflows: ${workflows.length} (${workflows.map((workflow) => workflow.definition.name).join(", ")})`,
				`Scheduler: ${runtime.scheduler.activeCount} active, ${runtime.scheduler.queuedCount} queued, limit ${config.maxConcurrency}`,
				`Retries: ${config.maxRetries} process-level, ${config.retryBaseDelayMs} ms base delay`,
				`Run store: ${runtime.store.root}`,
				`Orphaned runs: ${stale}`,
				`Pi executable: ${process.execPath}`,
			];
			if (agents.some((agent) => agent.skills.length))
				lines.push(
					"Warning: agent frontmatter skills are parsed but explicit child skill-path loading is not implemented yet.",
				);
			ctx.ui.notify(lines.join("\n"), stale ? "warning" : "info");
		},
	});
}
