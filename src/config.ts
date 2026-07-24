import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "./types.ts";

export const DEFAULT_CONFIG: ExtensionConfig = {
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

function readObject(filePath: string): Partial<ExtensionConfig> {
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
		return value && typeof value === "object" && !Array.isArray(value)
			? value
			: {};
	} catch {
		return {};
	}
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

export function loadConfig(
	cwd: string,
	projectTrusted: boolean,
): ExtensionConfig {
	const user = readObject(path.join(getAgentDir(), "pi-subagents.json"));
	const project = projectTrusted
		? readObject(path.join(cwd, CONFIG_DIR_NAME, "pi-subagents.json"))
		: {};
	const raw = { ...DEFAULT_CONFIG, ...user, ...project };
	const legacy = raw as ExtensionConfig & { showWidget?: unknown };
	const hardMaxFanout = positiveInteger(
		raw.hardMaxFanout,
		DEFAULT_CONFIG.hardMaxFanout,
		256,
	);
	return {
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
		showStatus: raw.showStatus !== false && legacy.showWidget !== false,
		confirmProjectAgents: raw.confirmProjectAgents !== false,
		confirmProjectWorkflows: raw.confirmProjectWorkflows !== false,
	};
}
