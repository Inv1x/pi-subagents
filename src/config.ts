import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { isThinkingLevel } from "./model-options.ts";
import type {
	AgentModelProfile,
	Difficulty,
	ExtensionConfig,
} from "./types.ts";

const AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const DEFAULT_CONFIG: ExtensionConfig = {
	agentModels: {},
	maxConcurrency: 4,
	maxWorkflowConcurrency: 4,
	maxFanout: 16,
	hardMaxFanout: 64,
	maxWorkflowNodes: 100,
	defaultTimeoutMs: 60 * 60_000,
	defaultMaxTurns: 128,
	maxRetries: 2,
	retryBaseDelayMs: 2_000,
	resultMaxBytes: 50 * 1024,
	transcriptMaxEvents: 500,
	retentionDays: 30,
	showStatus: true,
	confirmProjectAgents: true,
	confirmProjectWorkflows: true,
};

function readObject(filePath: string): Record<string, unknown> {
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: {};
	} catch {
		return {};
	}
}

export function normalizeAgentModels(
	value: unknown,
): Record<string, AgentModelProfile[]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const result: Record<string, AgentModelProfile[]> = {};
	for (const [agent, candidate] of Object.entries(value)) {
		if (!AGENT_NAME.test(agent) || !Array.isArray(candidate)) continue;
		const byThreshold = new Map<Difficulty, AgentModelProfile>();
		for (const item of candidate) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const raw = item as Record<string, unknown>;
			if (
				typeof raw.model !== "string" ||
				!/^\S+\/\S+$/.test(raw.model.trim()) ||
				!isThinkingLevel(raw.thinking) ||
				!Number.isInteger(raw.maxDifficulty) ||
				(raw.maxDifficulty as number) < 1 ||
				(raw.maxDifficulty as number) > 5
			)
				continue;
			const maxDifficulty = raw.maxDifficulty as Difficulty;
			byThreshold.set(maxDifficulty, {
				model: raw.model.trim(),
				thinking: raw.thinking,
				maxDifficulty,
			});
		}
		if (candidate.length === 0) result[agent] = [];
		else if (byThreshold.size > 0)
			result[agent] = [...byThreshold.values()].sort(
				(a, b) => a.maxDifficulty - b.maxDifficulty,
			);
	}
	return result;
}

export function mergeAgentModels(
	user: unknown,
	project: unknown,
): Record<string, AgentModelProfile[]> {
	return {
		...normalizeAgentModels(user),
		...normalizeAgentModels(project),
	};
}

export function userConfigPath(): string {
	return path.join(getAgentDir(), "pi-subagents.json");
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "pi-subagents.json");
}

export function readAgentModelsFile(
	filePath: string,
): Record<string, AgentModelProfile[]> {
	return normalizeAgentModels(readObject(filePath).agentModels);
}

function readObjectForWrite(filePath: string): Record<string, unknown> {
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("the root value must be an object");
		}
		return value as Record<string, unknown>;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
		throw new Error(
			`Cannot update ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function updateAgentModelsFile(
	filePath: string,
	agent: string,
	profiles: readonly AgentModelProfile[] | undefined,
): void {
	if (!AGENT_NAME.test(agent)) throw new Error(`Invalid agent name: ${agent}`);
	const current = readObjectForWrite(filePath);
	const rawModels = current.agentModels;
	if (
		rawModels !== undefined &&
		(!rawModels || typeof rawModels !== "object" || Array.isArray(rawModels))
	) {
		throw new Error(
			`Cannot update ${filePath}: agentModels must be an object.`,
		);
	}
	const models = { ...(rawModels as Record<string, unknown> | undefined) };
	if (profiles === undefined) delete models[agent];
	else models[agent] = normalizeAgentModels({ [agent]: profiles })[agent] ?? [];
	const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
	try {
		fs.writeFileSync(
			temporary,
			`${JSON.stringify({ ...current, agentModels: models }, null, 2)}\n`,
			{ encoding: "utf8", mode: 0o600 },
		);
		fs.renameSync(temporary, filePath);
	} catch (error) {
		try {
			fs.unlinkSync(temporary);
		} catch {
			/* best effort */
		}
		throw error;
	}
	try {
		fs.chmodSync(filePath, 0o600);
	} catch {
		/* best effort */
	}
}

export function writeAgentModelsFile(
	filePath: string,
	agent: string,
	profiles: readonly AgentModelProfile[],
): void {
	updateAgentModelsFile(filePath, agent, profiles);
}

export function deleteAgentModelsFile(filePath: string, agent: string): void {
	updateAgentModelsFile(filePath, agent, undefined);
}

function positiveInteger(
	value: unknown,
	fallback: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	return Number.isInteger(value) && (value as number) > 0
		? Math.min(value as number, maximum)
		: fallback;
}

function nonNegativeInteger(
	value: unknown,
	fallback: number,
	maximum = Number.MAX_SAFE_INTEGER,
): number {
	return Number.isInteger(value) && (value as number) >= 0
		? Math.min(value as number, maximum)
		: fallback;
}

function statusSetting(layer: Record<string, unknown>): unknown {
	// showWidget was the old name; the canonical name wins within each scope.
	return layer.showStatus !== undefined ? layer.showStatus : layer.showWidget;
}

export function resolveShowStatus(
	user: Record<string, unknown>,
	project: Record<string, unknown>,
): boolean {
	const projectValue = statusSetting(project);
	const configured =
		projectValue !== undefined ? projectValue : statusSetting(user);
	return configured !== false;
}

export function loadConfig(
	cwd: string,
	projectTrusted: boolean,
): ExtensionConfig {
	const user = readObject(userConfigPath());
	const project = projectTrusted ? readObject(projectConfigPath(cwd)) : {};
	const raw = { ...DEFAULT_CONFIG, ...user, ...project };
	const hardMaxFanout = positiveInteger(
		raw.hardMaxFanout,
		DEFAULT_CONFIG.hardMaxFanout,
		256,
	);
	return {
		agentModels: mergeAgentModels(user.agentModels, project.agentModels),
		maxConcurrency: positiveInteger(
			raw.maxConcurrency,
			DEFAULT_CONFIG.maxConcurrency,
			32,
		),
		maxWorkflowConcurrency: positiveInteger(
			raw.maxWorkflowConcurrency,
			DEFAULT_CONFIG.maxWorkflowConcurrency,
			32,
		),
		maxFanout: positiveInteger(
			raw.maxFanout,
			DEFAULT_CONFIG.maxFanout,
			hardMaxFanout,
		),
		hardMaxFanout,
		maxWorkflowNodes: positiveInteger(
			raw.maxWorkflowNodes,
			DEFAULT_CONFIG.maxWorkflowNodes,
			1000,
		),
		defaultTimeoutMs: positiveInteger(
			raw.defaultTimeoutMs,
			DEFAULT_CONFIG.defaultTimeoutMs,
			24 * 60 * 60_000,
		),
		defaultMaxTurns: positiveInteger(
			raw.defaultMaxTurns,
			DEFAULT_CONFIG.defaultMaxTurns,
			200,
		),
		maxRetries: nonNegativeInteger(
			raw.maxRetries,
			DEFAULT_CONFIG.maxRetries,
			5,
		),
		retryBaseDelayMs: nonNegativeInteger(
			raw.retryBaseDelayMs,
			DEFAULT_CONFIG.retryBaseDelayMs,
			60_000,
		),
		resultMaxBytes: positiveInteger(
			raw.resultMaxBytes,
			DEFAULT_CONFIG.resultMaxBytes,
			1024 * 1024,
		),
		transcriptMaxEvents: positiveInteger(
			raw.transcriptMaxEvents,
			DEFAULT_CONFIG.transcriptMaxEvents,
			10_000,
		),
		retentionDays: positiveInteger(
			raw.retentionDays,
			DEFAULT_CONFIG.retentionDays,
			3650,
		),
		showStatus: resolveShowStatus(user, project),
		confirmProjectAgents: raw.confirmProjectAgents !== false,
		confirmProjectWorkflows: raw.confirmProjectWorkflows !== false,
	};
}
