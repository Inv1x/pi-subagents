import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { isThinkingLevel } from "./model-options.ts";
import type {
	AgentDefinition,
	AgentSource,
	ContextMode,
	ExtensionConfig,
	WorkspaceMode,
} from "./types.ts";

const PACKAGE_ROOT = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
interface RawFrontmatter extends Record<string, unknown> {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	model?: unknown;
	thinking?: unknown;
	context?: unknown;
	workspace?: unknown;
	maxTurns?: unknown;
	timeoutMs?: unknown;
	skills?: unknown;
	systemPromptMode?: unknown;
	inheritProjectContext?: unknown;
}

function stringList(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		const result = value
			.filter((item): item is string => typeof item === "string")
			.map((item) => item.trim())
			.filter(Boolean);
		return result;
	}
	if (typeof value !== "string") return undefined;
	const result = value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return result;
}

function positiveInteger(value: unknown, fallback: number): number {
	if (typeof value === "number" && Number.isInteger(value) && value > 0)
		return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
	return fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true") return true;
	if (value === "false") return false;
	return fallback;
}

function parseAgentFile(
	filePath: string,
	source: AgentSource,
	config: ExtensionConfig,
): AgentDefinition | undefined {
	let content: string;
	try {
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return undefined;
	}
	const parsed = parseFrontmatter<RawFrontmatter>(content);
	const frontmatter = parsed.frontmatter;
	if (
		typeof frontmatter.name !== "string" ||
		!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(frontmatter.name)
	)
		return undefined;
	if (
		typeof frontmatter.description !== "string" ||
		!frontmatter.description.trim()
	)
		return undefined;
	const context: ContextMode =
		frontmatter.context === "summary" ? "summary" : "fresh";
	const workspace: WorkspaceMode =
		frontmatter.workspace === "worktree" ? "worktree" : "shared";
	const thinking = isThinkingLevel(frontmatter.thinking)
		? frontmatter.thinking
		: undefined;
	return {
		name: frontmatter.name,
		description: frontmatter.description.trim(),
		systemPrompt: parsed.body.trim(),
		tools: stringList(frontmatter.tools),
		model:
			typeof frontmatter.model === "string" && frontmatter.model !== "inherit"
				? frontmatter.model
				: undefined,
		thinking,
		context,
		workspace,
		maxTurns: positiveInteger(frontmatter.maxTurns, config.defaultMaxTurns),
		timeoutMs: positiveInteger(frontmatter.timeoutMs, config.defaultTimeoutMs),
		skills: stringList(frontmatter.skills) ?? [],
		systemPromptMode:
			frontmatter.systemPromptMode === "append" ? "append" : "replace",
		inheritProjectContext: booleanValue(
			frontmatter.inheritProjectContext,
			source === "builtin" || source === "project",
		),
		source,
		filePath,
	};
}

function walkMarkdownFiles(directory: string): string[] {
	if (!fs.existsSync(directory)) return [];
	const result: string[] = [];
	const visit = (current: string) => {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const fullPath = path.join(current, entry.name);
			if (entry.isDirectory()) visit(fullPath);
			else if (
				(entry.isFile() || entry.isSymbolicLink()) &&
				entry.name.endsWith(".md")
			)
				result.push(fullPath);
		}
	};
	visit(directory);
	return result.sort();
}

function loadDirectory(
	directory: string,
	source: AgentSource,
	config: ExtensionConfig,
): AgentDefinition[] {
	return walkMarkdownFiles(directory)
		.map((filePath) => parseAgentFile(filePath, source, config))
		.filter((agent): agent is AgentDefinition => Boolean(agent));
}

export interface ChildSystemPromptOptions {
	runName?: string;
	maxTurns: number;
	timeoutMs: number;
}

function formatTimeout(timeoutMs: number): string {
	const minutes = Math.max(1, Math.floor(timeoutMs / 60_000));
	if (minutes % 60 === 0) {
		const hours = minutes / 60;
		return `${hours} ${hours === 1 ? "hour" : "hours"}`;
	}
	return `${minutes} minutes`;
}

export function buildChildSystemPrompt(
	definition: AgentDefinition,
	options: ChildSystemPromptOptions,
): string {
	return [
		definition.systemPrompt,
		options.runName && options.runName !== definition.name
			? `Your run name is ${options.runName}; your behavior and tool access are based on the ${definition.name} agent definition.`
			: undefined,
		"You are a child agent delegated by a parent Pi session. Complete only the assigned task.",
		"Do not spawn or propose additional subagents. Return a concise result suitable for the parent to consume.",
		`Safety limits: at most ${options.maxTurns} assistant turns and ${formatTimeout(options.timeoutMs)} wall-clock. These are emergency ceilings, not targets. Use tools efficiently, batch independent operations where practical, stop exploring once evidence is sufficient, and reserve enough budget for a final response. If the full task cannot be completed, return the best evidence-based partial result and remaining work instead of allowing the run to end without a handoff.`,
	]
		.filter(Boolean)
		.join("\n\n");
}

export interface AgentDiscoveryOptions {
	cwd: string;
	projectTrusted: boolean;
	scope: "user" | "project" | "both";
	config: ExtensionConfig;
}

export function discoverAgents(
	options: AgentDiscoveryOptions,
): AgentDefinition[] {
	const map = new Map<string, AgentDefinition>();
	for (const agent of loadDirectory(
		path.join(PACKAGE_ROOT, "agents"),
		"builtin",
		options.config,
	))
		map.set(agent.name, agent);
	if (options.scope !== "project") {
		for (const agent of loadDirectory(
			path.join(getAgentDir(), "agents"),
			"user",
			options.config,
		))
			map.set(agent.name, agent);
	}
	if (options.scope !== "user" && options.projectTrusted) {
		for (const agent of loadDirectory(
			path.join(options.cwd, CONFIG_DIR_NAME, "agents"),
			"project",
			options.config,
		))
			map.set(agent.name, agent);
	}
	return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function packageRoot(): string {
	return PACKAGE_ROOT;
}

export function isWriteCapable(agent: AgentDefinition): boolean {
	if (!agent.tools) return true;
	return agent.tools.some(
		(tool) => tool === "bash" || tool === "edit" || tool === "write",
	);
}
