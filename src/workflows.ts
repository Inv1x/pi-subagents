import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { buildChildSystemPrompt, resolveNamedSkillPaths } from "./agents.ts";
import { observe } from "./observation.ts";
import { truncateUtf8 } from "./protocol.ts";
import {
	type AgentModelRoute,
	resolveAgentModelRoute,
	resolveDifficulty,
} from "./routing.ts";
import type { SubagentRuntime } from "./runtime.ts";
import type {
	AgentDefinition,
	ResolvedAgentRunRequest,
	RunError,
	RunRecord,
	RunState,
	WorkflowRoutingSnapshot,
	WorkflowSnapshot,
	WorkflowStepRecord,
} from "./types.ts";
import type {
	WorkflowAgentResult,
	WorkflowAgentSpec,
	WorkflowContext,
	WorkflowDefinition,
	WorkflowMapOptions,
} from "./workflow-api.ts";

const PACKAGE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
const jiti = createJiti(import.meta.url);

function stable(value: unknown): string {
	if (value === undefined) return "undefined";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	const object = value as Record<string, unknown>;
	return `{${Object.keys(object)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${stable(object[key])}`)
		.join(",")}}`;
}

function hash(value: unknown): string {
	return createHash("sha256")
		.update(typeof value === "string" ? value : stable(value))
		.digest("hex");
}

function walk(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	const result: string[] = [];
	const visit = (current: string) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else if (
				(entry.isFile() || entry.isSymbolicLink()) &&
				/\.workflow\.(ts|js|mjs)$/.test(entry.name)
			)
				result.push(fullPath);
		}
	};
	visit(directory);
	return result.sort();
}

export type WorkflowSource = "builtin" | "user" | "project";

export interface DiscoveredWorkflow {
	definition: WorkflowDefinition;
	source: WorkflowSource;
	filePath: string;
	definitionHash: string;
	/** Project workflow code remains unloaded until launch confirmation. */
	loaded?: boolean;
}

function validDefinition(
	definition: unknown,
): definition is WorkflowDefinition {
	return Boolean(
		definition &&
			typeof definition === "object" &&
			typeof (definition as WorkflowDefinition).name === "string" &&
			/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(
				(definition as WorkflowDefinition).name,
			) &&
			typeof (definition as WorkflowDefinition).description === "string" &&
			typeof (definition as WorkflowDefinition).run === "function",
	);
}

function literalMetadata(
	sourceText: string,
): { name: string; description: string } | undefined {
	const literal = (field: string) => {
		const match = sourceText.match(
			new RegExp(`\\b${field}\\s*:\\s*(["'])((?:\\\\.|(?!\\1)[\\s\\S])*?)\\1`),
		);
		if (!match?.[2]) return undefined;
		try {
			return JSON.parse(`"${match[2].replace(/"/g, '\\"')}"`) as string;
		} catch {
			return match[2];
		}
	};
	const name = literal("name");
	const description = literal("description");
	if (!name || !description || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(name))
		return undefined;
	return { name, description };
}

function readInertMetadata(filePath: string, sourceText: string) {
	const metadataPath = filePath.replace(/\.(?:ts|js|mjs)$/, ".json");
	try {
		const metadata = JSON.parse(
			fs.readFileSync(metadataPath, "utf8"),
		) as Record<string, unknown>;
		if (
			typeof metadata.name === "string" &&
			typeof metadata.description === "string" &&
			/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(metadata.name)
		)
			return { name: metadata.name, description: metadata.description };
	} catch {
		// Companion metadata is optional; conservative literal extraction is inert.
	}
	return literalMetadata(sourceText);
}

async function loadFile(
	filePath: string,
	source: WorkflowSource,
): Promise<DiscoveredWorkflow | undefined> {
	const sourceText = fs.readFileSync(filePath, "utf8");
	const definitionHash = hash(sourceText);
	if (source === "project") {
		const metadata = readInertMetadata(filePath, sourceText);
		if (!metadata) return undefined;
		return {
			definition: {
				...metadata,
				run: () => {
					throw new Error(
						"Project workflow was not activated after confirmation.",
					);
				},
			},
			source,
			filePath,
			definitionHash,
			loaded: false,
		};
	}
	try {
		const definition = await jiti.import<WorkflowDefinition>(filePath, {
			default: true,
		});
		if (!validDefinition(definition)) return undefined;
		return { definition, source, filePath, definitionHash, loaded: true };
	} catch (error) {
		console.error(`[pi-subagents] Could not load workflow ${filePath}:`, error);
		return undefined;
	}
}

export async function loadWorkflowForExecution(
	workflow: DiscoveredWorkflow,
): Promise<DiscoveredWorkflow> {
	if (workflow.loaded !== false) return workflow;
	const sourceText = fs.readFileSync(workflow.filePath, "utf8");
	if (hash(sourceText) !== workflow.definitionHash)
		throw new Error(
			"Project workflow changed after preview; preview it again.",
		);
	const definition = await jiti.import<WorkflowDefinition>(workflow.filePath, {
		default: true,
	});
	if (
		!validDefinition(definition) ||
		definition.name !== workflow.definition.name
	)
		throw new Error(
			"Project workflow export does not match its inert discovery metadata.",
		);
	return { ...workflow, definition, loaded: true };
}

export async function discoverWorkflows(
	cwd: string,
	projectTrusted: boolean,
): Promise<DiscoveredWorkflow[]> {
	const map = new Map<string, DiscoveredWorkflow>();
	for (const filePath of walk(path.join(PACKAGE_ROOT, "workflows"))) {
		const loaded = await loadFile(filePath, "builtin");
		if (loaded) map.set(loaded.definition.name, loaded);
	}
	for (const filePath of walk(path.join(getAgentDir(), "workflows"))) {
		const loaded = await loadFile(filePath, "user");
		if (loaded) map.set(loaded.definition.name, loaded);
	}
	if (projectTrusted) {
		for (const filePath of walk(path.join(cwd, CONFIG_DIR_NAME, "workflows"))) {
			const loaded = await loadFile(filePath, "project");
			if (loaded) map.set(loaded.definition.name, loaded);
		}
	}
	return [...map.values()].sort((a, b) =>
		a.definition.name.localeCompare(b.definition.name),
	);
}

interface WorkflowExecutionOptions {
	cwd: string;
	sessionId?: string;
	background: boolean;
	defaultModel?: string;
	defaultThinking?: ResolvedAgentRunRequest["thinking"];
	resolveThinking?: (
		model: string | undefined,
		thinking: ResolvedAgentRunRequest["thinking"],
	) => ResolvedAgentRunRequest["thinking"];
	routing?: WorkflowRoutingSnapshot;
	contextSummary?: string;
	projectTrusted?: boolean;
	resolveAgentRoute?: (
		definition: AgentDefinition,
		spec: WorkflowAgentSpec,
		routing: WorkflowRoutingSnapshot | undefined,
	) => AgentModelRoute;
	validateAgentRoute?: (
		route: AgentModelRoute,
		routing: WorkflowRoutingSnapshot | undefined,
	) => AgentModelRoute;
	resolveAgent: (name: string) => AgentDefinition | undefined;
	signal?: AbortSignal;
	onCreated?: (record: RunRecord) => void;
	existingRunId?: string;
}

interface ActiveWorkflow {
	controller: AbortController;
	promise: Promise<RunRecord>;
}

function asAgentResult(record: RunRecord): WorkflowAgentResult {
	return {
		runId: record.id,
		state: record.state,
		output: record.output ?? record.error?.message ?? "(no output)",
		outputArtifact: record.outputArtifact,
		patchArtifact: record.patchArtifact,
		model: record.model,
		thinking: record.thinking,
		usage: {
			turns: record.usage.turns,
			input: record.usage.input,
			output: record.usage.output,
			cacheRead: record.usage.cacheRead,
			cacheWrite: record.usage.cacheWrite,
			cost: record.usage.cost,
		},
	};
}

function stepError(error: unknown): RunError {
	return {
		code: "workflow_step_failed",
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
	};
}

function assertSchema(
	schema: TSchema | undefined,
	value: unknown,
	label: string,
): void {
	if (!schema) return;
	try {
		if (Value.Check(schema, value)) return;
	} catch (error) {
		throw new Error(
			`${label} schema is invalid: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	throw new Error(`${label} does not match its declared schema.`);
}

function canonicalizeJson(value: unknown, label: string): unknown {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch (error) {
		throw new Error(
			`${label} is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	if (serialized === undefined)
		throw new Error(`${label} is not JSON-serializable.`);
	return JSON.parse(serialized);
}

function isWorkflowAgentResult(value: unknown): value is WorkflowAgentResult {
	if (!value || typeof value !== "object") return false;
	const result = value as Partial<WorkflowAgentResult>;
	return (
		typeof result.runId === "string" &&
		typeof result.state === "string" &&
		typeof result.output === "string" &&
		Boolean(result.usage && typeof result.usage === "object")
	);
}

function parseStructuredOutput(
	output: string,
	schema: TSchema,
	stepId: string,
): unknown {
	let value: unknown;
	try {
		value = JSON.parse(output);
	} catch {
		throw new Error(
			`Step '${stepId}' declared an output schema but did not return valid JSON.`,
		);
	}
	assertSchema(schema, value, `Step '${stepId}' output`);
	return value;
}

function validateAgentSpec(spec: WorkflowAgentSpec): void {
	if (!spec || typeof spec !== "object")
		throw new Error("Workflow agent specification must be an object.");
	if (typeof spec.agent !== "string" || !spec.agent.trim())
		throw new Error("Workflow agent name must be a non-empty string.");
	if (typeof spec.task !== "string" || !spec.task.trim())
		throw new Error("Workflow agent task must be a non-empty string.");
	if (
		spec.context !== undefined &&
		!["fresh", "summary"].includes(spec.context)
	)
		throw new Error(`Invalid workflow context '${String(spec.context)}'.`);
	if (
		spec.workspace !== undefined &&
		!["shared", "worktree"].includes(spec.workspace)
	)
		throw new Error(`Invalid workflow workspace '${String(spec.workspace)}'.`);
	if (spec.cwd !== undefined && typeof spec.cwd !== "string")
		throw new Error("Workflow agent cwd must be a string.");
	for (const [name, value] of [
		["timeoutMs", spec.timeoutMs],
		["maxTurns", spec.maxTurns],
	] as const) {
		if (
			value !== undefined &&
			(!Number.isInteger(value) || (value as number) <= 0)
		)
			throw new Error(`Workflow ${name} must be a positive integer.`);
	}
}

function validateMapOptions(options: WorkflowMapOptions): void {
	if (
		options.concurrency !== undefined &&
		(!Number.isInteger(options.concurrency) || options.concurrency <= 0)
	)
		throw new Error("Workflow map concurrency must be a positive integer.");
	if (options.failFast !== undefined && typeof options.failFast !== "boolean")
		throw new Error("Workflow map failFast must be a boolean.");
}

export class WorkflowEngine {
	private readonly active = new Map<string, ActiveWorkflow>();

	constructor(private readonly runtime: SubagentRuntime) {}

	async start(
		workflow: DiscoveredWorkflow,
		input: unknown,
		options: WorkflowExecutionOptions,
	): Promise<RunRecord> {
		assertSchema(
			workflow.definition.input,
			input,
			`Workflow '${workflow.definition.name}' input`,
		);
		let record: RunRecord;
		let snapshot: WorkflowSnapshot;
		if (options.existingRunId) {
			record =
				this.runtime.get(options.existingRunId) ??
				(() => {
					throw new Error(`Workflow run not found: ${options.existingRunId}`);
				})();
			snapshot =
				this.runtime.store.readWorkflow(record.id) ??
				(() => {
					throw new Error(`Workflow snapshot missing: ${record.id}`);
				})();
			if (snapshot.workflow !== workflow.definition.name)
				throw new Error(
					`Run ${record.id} belongs to workflow ${snapshot.workflow}, not ${workflow.definition.name}.`,
				);
			if (snapshot.definitionHash !== workflow.definitionHash)
				throw new Error(
					"Workflow definition changed since this run started. Start a new run instead of resuming to avoid replay drift.",
				);
			if (this.active.has(record.id)) return record;
		} else {
			record = this.runtime.createWorkflowRecord(
				workflow.definition.name,
				input,
				options,
			);
			snapshot = {
				version: 1,
				runId: record.id,
				workflow: workflow.definition.name,
				input,
				definitionPath: workflow.filePath,
				definitionHash: workflow.definitionHash,
				routing: options.routing,
				...(options.contextSummary
					? { contextSummary: options.contextSummary.slice(-12_000) }
					: {}),
				state: "queued",
				createdAt: record.createdAt,
				updatedAt: record.updatedAt,
				steps: {},
			};
			this.runtime.store.writeWorkflow(snapshot);
		}

		options.onCreated?.({ ...record });
		const controller = new AbortController();
		const parentAbort = () =>
			controller.abort(
				options.signal?.reason ?? new Error("Parent turn aborted"),
			);
		if (options.signal?.aborted) parentAbort();
		else options.signal?.addEventListener("abort", parentAbort, { once: true });
		const promise = this.execute(
			record,
			snapshot,
			workflow,
			options,
			controller,
		)
			.catch((error) =>
				this.settleUnexpectedFailure(record, snapshot, controller, error),
			)
			.finally(() => {
				options.signal?.removeEventListener("abort", parentAbort);
				this.active.delete(record.id);
			});
		this.active.set(record.id, { controller, promise });
		if (options.background) {
			void promise;
			return record;
		}
		return promise;
	}

	async wait(
		idOrPrefix: string,
		timeoutMs?: number,
		signal?: AbortSignal,
	): Promise<RunRecord> {
		const record = this.runtime.get(idOrPrefix);
		if (record?.kind !== "workflow")
			throw new Error(`Workflow run not found: ${idOrPrefix}`);
		const active = this.active.get(record.id);
		if (!active) return record;
		return observe(active.promise, {
			timeoutMs,
			onTimeout: timeoutMs
				? () => ({ ...(this.runtime.get(record.id) ?? record) })
				: undefined,
			signal,
			abortMessage: `Stopped waiting for workflow ${record.id}; it continues in the background.`,
		});
	}

	stop(idOrPrefix: string): RunRecord {
		const record = this.runtime.get(idOrPrefix);
		if (record?.kind !== "workflow")
			throw new Error(`Workflow run not found: ${idOrPrefix}`);
		const active = this.active.get(record.id);
		if (!active) return record;
		active.controller.abort(new Error("Workflow stopped by user"));
		return record;
	}

	private async execute(
		record: RunRecord,
		snapshot: WorkflowSnapshot,
		workflow: DiscoveredWorkflow,
		options: WorkflowExecutionOptions,
		controller: AbortController,
	): Promise<RunRecord> {
		this.setSnapshotState(snapshot, "running");
		this.runtime.updateManagedRun(record.id, "running", {
			startedAt: record.startedAt ?? Date.now(),
			error: undefined,
			...(options.background
				? {
						background: true,
						metadata: {
							...record.metadata,
							completionPending: true,
							completionGeneration: options.existingRunId
								? Number(record.metadata?.completionGeneration ?? 0) + 1
								: Number(record.metadata?.completionGeneration ?? 1),
							completionEnqueuedAt: undefined,
							completionDeliveredAt: undefined,
						},
					}
				: {}),
		});
		let explicitResult: unknown;
		const assertNodeBudget = (id: string) => {
			if (
				!snapshot.steps[id] &&
				Object.keys(snapshot.steps).length >=
					this.runtime.getConfig().maxWorkflowNodes
			) {
				throw new Error(
					`Workflow node limit (${this.runtime.getConfig().maxWorkflowNodes}) exceeded.`,
				);
			}
		};
		const persistStep = (step: WorkflowStepRecord) => {
			snapshot.steps[step.id] = step;
			snapshot.updatedAt = Date.now();
			this.runtime.store.writeWorkflow(snapshot);
		};
		const executeAgentStep = async (
			stepId: string,
			spec: WorkflowAgentSpec,
		): Promise<WorkflowAgentResult> => {
			if (controller.signal.aborted)
				throw controller.signal.reason ?? new Error("Workflow cancelled");
			validateAgentSpec(spec);
			assertNodeBudget(stepId);
			const specHash = hash(spec);
			const existing = snapshot.steps[stepId];
			if (existing) {
				if (existing.specHash !== specHash)
					throw new Error(
						`Workflow drift at step '${stepId}': the step specification changed.`,
					);
				if (existing.state === "succeeded")
					return existing.result as WorkflowAgentResult;
			}
			const routing = snapshot.routing ?? options.routing;
			const definition =
				routing?.agents[spec.agent] ?? options.resolveAgent(spec.agent);
			if (!definition) throw new Error(`Unknown workflow agent: ${spec.agent}`);
			const savedRoute = existing?.metadata?.route as
				| AgentModelRoute
				| undefined;
			const route =
				(savedRoute
					? (options.validateAgentRoute?.(savedRoute, routing) ?? savedRoute)
					: undefined) ??
				options.resolveAgentRoute?.(definition, spec, routing) ??
				resolveAgentModelRoute({
					difficulty: spec.difficulty,
					model: spec.model,
					thinking: spec.thinking,
					profiles: routing?.agentModels[definition.name],
					definitionModel: definition.model,
					definitionThinking: definition.thinking,
					parentModel: routing ? routing.defaultModel : options.defaultModel,
					parentThinking: routing
						? routing.defaultThinking
						: options.defaultThinking,
				});
			if (
				route.model !== undefined &&
				routing?.scopedModels !== undefined &&
				!routing.scopedModels.includes(route.model)
			) {
				throw new Error(
					`Workflow model route '${route.model}' is outside the pinned scopedModels selection.`,
				);
			}
			const model = route.model;
			const thinking =
				options.resolveThinking?.(model, route.thinking) ?? route.thinking;
			const persistedRoute: AgentModelRoute = {
				difficulty: resolveDifficulty(route.difficulty),
				model,
				thinking,
				...(route.profile ? { profile: route.profile } : {}),
			};
			const step: WorkflowStepRecord = {
				id: stepId,
				kind: "agent",
				state: "running",
				specHash,
				createdAt: existing?.createdAt ?? Date.now(),
				updatedAt: Date.now(),
				metadata: {
					agent: spec.agent,
					task: spec.task,
					route: persistedRoute,
				},
			};
			persistStep(step);
			const timeoutMs = spec.timeoutMs ?? definition.timeoutMs;
			const maxTurns = spec.maxTurns ?? definition.maxTurns;
			const context = spec.context ?? definition.context;
			const summary = snapshot.contextSummary ?? options.contextSummary;
			const taskWithContext =
				context === "summary" && summary
					? `${spec.task}\n\n<workflow_context>\n${summary}\n</workflow_context>`
					: spec.task;
			const task = spec.output
				? `${taskWithContext}\n\nReturn the final response as JSON only, matching this schema:\n${JSON.stringify(spec.output)}`
				: taskWithContext;
			const request: ResolvedAgentRunRequest = {
				agent: definition.name,
				task,
				definition,
				difficulty: persistedRoute.difficulty,
				profileMaxDifficulty: persistedRoute.profile?.maxDifficulty,
				background: false,
				context,
				cwd: spec.cwd ? path.resolve(options.cwd, spec.cwd) : options.cwd,
				workspace: spec.workspace ?? definition.workspace,
				timeoutMs,
				maxTurns,
				systemPrompt: buildChildSystemPrompt(definition, {
					maxTurns,
					timeoutMs,
				}),
				skillPaths: resolveNamedSkillPaths(
					definition.skills,
					options.cwd,
					options.projectTrusted ?? false,
				),
				model,
				thinking,
			};
			try {
				const child = await this.runtime.startAgent(request, {
					background: false,
					priority: options.background ? "background" : "foreground",
					sessionId: options.sessionId,
					parentRunId: record.id,
					stepId,
					signal: controller.signal,
					onCreated: (created) => {
						step.childRunIds = [created.id];
						step.updatedAt = Date.now();
						persistStep(step);
					},
				});
				const result = asAgentResult(child);
				step.state = child.state;
				step.result = result;
				step.error = child.error;
				if (child.state === "succeeded" && spec.output) {
					result.value = parseStructuredOutput(
						result.output,
						spec.output,
						stepId,
					);
				}
				step.updatedAt = Date.now();
				persistStep(step);
				this.recalculateUsage(record.id);
				if (child.state !== "succeeded")
					throw new Error(
						`Step '${stepId}' failed: ${child.error?.message ?? child.state}`,
					);
				return result;
			} catch (error) {
				step.state = controller.signal.aborted ? "cancelled" : "failed";
				step.error = stepError(error);
				step.updatedAt = Date.now();
				persistStep(step);
				throw error;
			}
		};

		const workflowEngine = this;
		const context: WorkflowContext = {
			runId: record.id,
			cwd: options.cwd,
			signal: controller.signal,
			agent: executeAgentStep,
			parallel: (groupId, specs, mapOptions) =>
				runMap(groupId, specs, (_spec) => _spec, mapOptions),
			map: runMap,
			log: (message, data) => {
				this.runtime.store.appendEvent(
					record.id,
					"workflow.log",
					record.state,
					{ message, ...data },
				);
			},
			output: <T = unknown>(stepId: string) =>
				snapshot.steps[stepId]?.result as T | undefined,
			setResult: (value) => {
				explicitResult = value;
			},
		};

		async function runMap<T>(
			groupId: string,
			items: readonly T[],
			factory: (item: T, index: number) => WorkflowAgentSpec,
			mapOptions: WorkflowMapOptions = {},
		): Promise<WorkflowAgentResult[]> {
			validateMapOptions(mapOptions);
			const maxFanout = Math.min(
				workflowEngine.runtime.getConfig().maxFanout,
				workflowEngine.runtime.getConfig().hardMaxFanout,
			);
			if (items.length > maxFanout)
				throw new Error(
					`Workflow fan-out ${items.length} exceeds limit ${maxFanout}.`,
				);
			assertNodeBudget(groupId);
			const specs = items.map(factory);
			const groupHash = hash({ specs, options: mapOptions });
			const existing = snapshot.steps[groupId];
			if (existing) {
				if (existing.specHash !== groupHash)
					throw new Error(`Workflow drift at map '${groupId}'.`);
				if (existing.state === "succeeded")
					return existing.result as WorkflowAgentResult[];
			}
			const group: WorkflowStepRecord = {
				id: groupId,
				kind: "map",
				state: "running",
				specHash: groupHash,
				createdAt: existing?.createdAt ?? Date.now(),
				updatedAt: Date.now(),
				metadata: { count: items.length, concurrency: mapOptions.concurrency },
			};
			persistStep(group);
			const concurrency = Math.max(
				1,
				Math.min(
					mapOptions.concurrency ??
						workflowEngine.runtime.getConfig().maxWorkflowConcurrency,
					items.length || 1,
				),
			);
			const results: WorkflowAgentResult[] = new Array(items.length);
			let next = 0;
			let firstError: unknown;
			const workers = Array.from({ length: concurrency }, async () => {
				while (true) {
					const index = next++;
					if (index >= items.length || (mapOptions.failFast && firstError))
						return;
					const spec = specs[index];
					if (!spec) return;
					const stepId = `${groupId}.${index}`;
					try {
						results[index] = await executeAgentStep(stepId, spec);
					} catch (error) {
						firstError ??= error;
						const failedStep = snapshot.steps[stepId];
						const persistedResult = failedStep?.result;
						if (isWorkflowAgentResult(persistedResult)) {
							results[index] = persistedResult;
							continue;
						}
						const childRunId = failedStep?.childRunIds?.at(-1);
						const child = childRunId
							? workflowEngine.runtime.get(childRunId)
							: undefined;
						results[index] = child
							? asAgentResult(child)
							: {
									runId: "",
									state: "failed",
									output:
										error instanceof Error ? error.message : String(error),
									usage: {
										turns: 0,
										input: 0,
										output: 0,
										cacheRead: 0,
										cacheWrite: 0,
										cost: 0,
									},
								};
					}
				}
			});
			await Promise.all(workers);
			group.result = results.filter(Boolean);
			group.state = firstError && mapOptions.failFast ? "failed" : "succeeded";
			group.error = firstError ? stepError(firstError) : undefined;
			group.updatedAt = Date.now();
			persistStep(group);
			if (firstError && mapOptions.failFast) throw firstError;
			return group.result as WorkflowAgentResult[];
		}

		try {
			const returned = await workflow.definition.run(context, snapshot.input);
			const result = canonicalizeJson(
				explicitResult ?? returned,
				`Workflow '${workflow.definition.name}' output`,
			);
			assertSchema(
				workflow.definition.output,
				result,
				`Workflow '${workflow.definition.name}' output`,
			);
			snapshot.result = result;
			this.setSnapshotState(snapshot, "succeeded");
			const output =
				(typeof result === "string"
					? result
					: JSON.stringify(result, null, 2)) || "Workflow completed.";
			const bounded = truncateUtf8(
				output,
				this.runtime.getConfig().resultMaxBytes,
			);
			const outputArtifact = this.runtime.store.writeText(
				record.id,
				"output.md",
				output,
			);
			return this.runtime.updateManagedRun(record.id, "succeeded", {
				output: bounded.text,
				outputArtifact,
				truncated: bounded.truncated,
				activity: undefined,
			});
		} catch (error) {
			const cancelled = controller.signal.aborted;
			const state: RunState = cancelled ? "cancelled" : "failed";
			const failure = stepError(error);
			this.setSnapshotState(snapshot, state);
			return this.runtime.updateManagedRun(record.id, state, {
				error: failure,
				output: failure.message,
				activity: undefined,
			});
		}
	}

	private settleUnexpectedFailure(
		record: RunRecord,
		snapshot: WorkflowSnapshot,
		controller: AbortController,
		error: unknown,
	): RunRecord {
		const state: RunState = controller.signal.aborted ? "cancelled" : "failed";
		const failure = stepError(error);
		try {
			this.setSnapshotState(snapshot, state);
		} catch (persistenceError) {
			console.error(
				`[pi-subagents] Could not persist failed workflow snapshot ${record.id}:`,
				persistenceError,
			);
		}
		try {
			return this.runtime.updateManagedRun(record.id, state, {
				error: failure,
				output: failure.message,
				activity: undefined,
			});
		} catch (persistenceError) {
			console.error(
				`[pi-subagents] Could not persist failed workflow run ${record.id}:`,
				persistenceError,
			);
			return { ...record, state, error: failure, output: failure.message };
		}
	}

	private setSnapshotState(snapshot: WorkflowSnapshot, state: RunState): void {
		snapshot.state = state;
		snapshot.updatedAt = Date.now();
		this.runtime.store.writeWorkflow(snapshot);
	}

	private recalculateUsage(parentRunId: string): void {
		const children = this.runtime
			.list(1000)
			.filter((record) => record.parentRunId === parentRunId);
		const usage = children.reduce(
			(total, child) => ({
				turns: total.turns + child.usage.turns,
				input: total.input + child.usage.input,
				output: total.output + child.usage.output,
				cacheRead: total.cacheRead + child.usage.cacheRead,
				cacheWrite: total.cacheWrite + child.usage.cacheWrite,
				cost: total.cost + child.usage.cost,
				contextTokens: total.contextTokens + child.usage.contextTokens,
			}),
			{
				turns: 0,
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: 0,
				contextTokens: 0,
			},
		);
		this.runtime.patchManagedRun(parentRunId, { usage });
	}
}

const ENGINE_SYMBOL = Symbol.for("pi-subagents.workflow-engine.v1");

export function getWorkflowEngine(runtime: SubagentRuntime): WorkflowEngine {
	const globals = globalThis as typeof globalThis & {
		[ENGINE_SYMBOL]?: WorkflowEngine;
	};
	globals[ENGINE_SYMBOL] ??= new WorkflowEngine(runtime);
	// Keep active workflows and their abort controllers across hot reloads while
	// adopting fixes and new methods from the current module instance.
	Object.setPrototypeOf(globals[ENGINE_SYMBOL], WorkflowEngine.prototype);
	return globals[ENGINE_SYMBOL];
}
