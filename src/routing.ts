import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { isThinkingLevel } from "./model-options.ts";
import type {
	AgentModelProfile,
	Difficulty,
	ResolvedAgentRunRequest,
} from "./types.ts";

export const DEFAULT_DIFFICULTY: Difficulty = 3;

export function resolveDifficulty(value: unknown): Difficulty {
	if (value === undefined) return DEFAULT_DIFFICULTY;
	if (
		typeof value === "number" &&
		Number.isInteger(value) &&
		value >= 1 &&
		value <= 5
	)
		return value as Difficulty;
	throw new Error("Child difficulty must be an integer from 1 to 5.");
}

export function selectAgentModelProfile(
	profiles: readonly AgentModelProfile[] | undefined,
	difficulty: Difficulty,
): AgentModelProfile | undefined {
	if (!profiles?.length) return undefined;
	const ordered = [...profiles].sort(
		(a, b) => a.maxDifficulty - b.maxDifficulty,
	);
	return (
		ordered.find((profile) => profile.maxDifficulty >= difficulty) ??
		ordered.at(-1)
	);
}

export interface AgentModelRoute {
	difficulty: Difficulty;
	model?: string;
	thinking?: ThinkingLevel;
	profile?: AgentModelProfile;
}

export function resolveAgentModelRoute(options: {
	difficulty?: unknown;
	model?: string;
	thinking?: ThinkingLevel;
	profiles?: readonly AgentModelProfile[];
	definitionModel?: string;
	definitionThinking?: ThinkingLevel;
	parentModel?: string;
	parentThinking?: ResolvedAgentRunRequest["thinking"];
}): AgentModelRoute {
	const difficulty = resolveDifficulty(options.difficulty);
	if (
		options.model !== undefined &&
		(typeof options.model !== "string" || !options.model.trim())
	)
		throw new Error("Child model override cannot be blank.");
	if (options.thinking !== undefined && !isThinkingLevel(options.thinking))
		throw new Error(
			`Invalid child thinking effort '${String(options.thinking)}'.`,
		);
	const profile = selectAgentModelProfile(options.profiles, difficulty);
	return {
		difficulty,
		model:
			options.model?.trim() ??
			profile?.model ??
			options.definitionModel ??
			options.parentModel,
		thinking:
			options.thinking ??
			profile?.thinking ??
			options.definitionThinking ??
			options.parentThinking,
		profile,
	};
}
