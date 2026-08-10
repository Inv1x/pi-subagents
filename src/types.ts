import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export type AgentSource = "builtin" | "package" | "user" | "project";
export type ContextMode = "fresh" | "summary";
export type WorkspaceMode = "shared" | "worktree";
export type RunKind = "agent" | "workflow";
export type Difficulty = 1 | 2 | 3 | 4 | 5;

export interface AgentModelProfile {
	model: string;
	thinking: ThinkingLevel;
	maxDifficulty: Difficulty;
}

export type RunState =
	| "queued"
	| "starting"
	| "running"
	| "paused"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "orphaned";

export const TERMINAL_STATES = new Set<RunState>([
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"orphaned",
]);

export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	thinking?: ThinkingLevel;
	context: ContextMode;
	workspace: WorkspaceMode;
	maxTurns: number;
	timeoutMs: number;
	skills: string[];
	systemPromptMode: "replace" | "append";
	inheritProjectContext: boolean;
	source: AgentSource;
	filePath: string;
}

export interface UsageStats {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
}

export interface RunError {
	code: string;
	message: string;
	retryable: boolean;
}

export interface ActivitySnapshot {
	tool?: string;
	path?: string;
	message?: string;
	updatedAt: number;
}

export interface RunRecord {
	version: 1;
	id: string;
	kind: RunKind;
	state: RunState;
	background: boolean;
	sessionId?: string;
	parentRunId?: string;
	stepId?: string;
	agent?: string;
	workflow?: string;
	task?: string;
	cwd: string;
	workspace: WorkspaceMode;
	model?: string;
	thinking?: ThinkingLevel;
	difficulty?: Difficulty;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	updatedAt: number;
	pid?: number;
	queuePosition?: number;
	activity?: ActivitySnapshot;
	usage: UsageStats;
	output?: string;
	outputArtifact?: string;
	transcriptArtifact?: string;
	patchArtifact?: string;
	truncated?: boolean;
	error?: RunError;
	metadata?: Record<string, unknown>;
}

export interface PersistedRunEvent {
	version: 1;
	sequence: number;
	timestamp: number;
	runId: string;
	type: string;
	state?: RunState;
	data?: Record<string, unknown>;
}

export interface AgentRunRequest {
	agent: string;
	baseAgent?: string;
	task: string;
	background?: boolean;
	context?: ContextMode;
	model?: string;
	thinking?: ThinkingLevel;
	difficulty?: Difficulty;
	cwd?: string;
	workspace?: WorkspaceMode;
	timeoutMs?: number;
	maxTurns?: number;
	maxRetries?: number;
	agentScope?: "user" | "project" | "both";
}

export interface ResolvedAgentRunRequest extends AgentRunRequest {
	definition: AgentDefinition;
	difficulty: Difficulty;
	profileMaxDifficulty?: Difficulty;
	background: boolean;
	context: ContextMode;
	cwd: string;
	workspace: WorkspaceMode;
	timeoutMs: number;
	maxTurns: number;
	systemPrompt: string;
	/** Exact skill files explicitly passed to the child process. */
	skillPaths?: string[];
}

export interface TransportEvent {
	type:
		| "started"
		| "activity"
		| "usage"
		| "retry"
		| "settled"
		| "stderr"
		| "protocol_error";
	data?: Record<string, unknown>;
}

export interface TransportResult {
	state: Extract<RunState, "succeeded" | "failed" | "timed_out" | "cancelled">;
	output: string;
	fullOutput?: string;
	usage: UsageStats;
	model?: string;
	pid?: number;
	error?: RunError;
	stderr?: string;
	transcript: string[];
	truncated: boolean;
}

export interface ExtensionConfig {
	agentModels: Record<string, AgentModelProfile[]>;
	maxConcurrency: number;
	maxWorkflowConcurrency: number;
	maxFanout: number;
	hardMaxFanout: number;
	maxWorkflowNodes: number;
	defaultTimeoutMs: number;
	defaultMaxTurns: number;
	maxRetries: number;
	retryBaseDelayMs: number;
	resultMaxBytes: number;
	transcriptMaxEvents: number;
	retentionDays: number;
	showStatus: boolean;
	confirmProjectAgents: boolean;
	confirmProjectWorkflows: boolean;
}

export interface SubagentToolDetails {
	run: RunRecord;
	recentActivity?: string[];
}

export interface ControlToolDetails {
	runs: RunRecord[];
}

export interface WorkflowStepRecord {
	id: string;
	kind: "agent" | "map" | "log";
	state: RunState;
	specHash: string;
	createdAt: number;
	updatedAt: number;
	result?: unknown;
	childRunIds?: string[];
	error?: RunError;
	metadata?: Record<string, unknown>;
}

export interface WorkflowRoutingSnapshot {
	defaultModel?: string;
	defaultThinking?: ThinkingLevel;
	/** @deprecated Read for compatibility; model routing ignores old session scopes. */
	scopedModels?: string[];
	agentModels: Record<string, AgentModelProfile[]>;
	agents: Record<string, AgentDefinition>;
}

export interface WorkflowSnapshot {
	version: 1;
	runId: string;
	workflow: string;
	input: unknown;
	definitionPath?: string;
	definitionHash: string;
	routing?: WorkflowRoutingSnapshot;
	/** Bounded parent context captured when the workflow was first launched. */
	contextSummary?: string;
	state: RunState;
	createdAt: number;
	updatedAt: number;
	result?: unknown;
	steps: Record<string, WorkflowStepRecord>;
}

export interface RunUpdate {
	run: RunRecord;
	previousState?: RunState;
}

/** Return a detached record so callers cannot mutate runtime-owned nested state. */
export function snapshotRunRecord(record: RunRecord): RunRecord {
	return structuredClone(record);
}
