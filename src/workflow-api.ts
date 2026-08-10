import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { TSchema } from "typebox";
import type { ContextMode, Difficulty, WorkspaceMode } from "./types.ts";

export interface WorkflowAgentSpec {
	agent: string;
	task: string;
	context?: ContextMode;
	model?: string;
	thinking?: ThinkingLevel;
	/** Head/workflow estimate from 1 (trivial) to 5 (critical). Defaults to 3. */
	difficulty?: Difficulty;
	cwd?: string;
	workspace?: WorkspaceMode;
	timeoutMs?: number;
	maxTurns?: number;
	/** Validate the child's final response as JSON against this TypeBox schema. */
	output?: TSchema;
}

export interface WorkflowAgentResult {
	runId: string;
	state: string;
	output: string;
	outputArtifact?: string;
	patchArtifact?: string;
	model?: string;
	thinking?: ThinkingLevel;
	/** Parsed value when the step declared an output schema. */
	value?: unknown;
	usage: {
		turns: number;
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: number;
	};
}

export interface WorkflowMapOptions {
	concurrency?: number;
	failFast?: boolean;
}

export interface WorkflowContext {
	readonly runId: string;
	readonly cwd: string;
	readonly signal: AbortSignal;
	agent(stepId: string, spec: WorkflowAgentSpec): Promise<WorkflowAgentResult>;
	parallel(
		groupId: string,
		specs: WorkflowAgentSpec[],
		options?: WorkflowMapOptions,
	): Promise<WorkflowAgentResult[]>;
	map<T>(
		groupId: string,
		items: readonly T[],
		factory: (item: T, index: number) => WorkflowAgentSpec,
		options?: WorkflowMapOptions,
	): Promise<WorkflowAgentResult[]>;
	log(message: string, data?: Record<string, unknown>): void;
	output<T = unknown>(stepId: string): T | undefined;
	setResult(value: unknown): void;
}

export interface WorkflowDefinition<TInput = unknown, TResult = unknown> {
	name: string;
	description: string;
	input?: TSchema;
	output?: TSchema;
	run(ctx: WorkflowContext, input: TInput): Promise<TResult> | TResult;
}

export function defineWorkflow<TInput = unknown, TResult = unknown>(
	definition: WorkflowDefinition<TInput, TResult>,
): WorkflowDefinition<TInput, TResult> {
	return definition;
}
