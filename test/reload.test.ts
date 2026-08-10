import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	type ExtensionAPI,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";
import { getWorkflowEngine, WorkflowEngine } from "../src/workflows.ts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedTools = [
	"subagent_run",
	"subagent_control",
	"workflow_run",
	"workflow_control",
];

function assertToolsRemainExposed(session: {
	getAllTools(): Array<{
		name: string;
		parameters?: { additionalProperties?: unknown };
	}>;
	getActiveToolNames(): string[];
}): void {
	const tools = session.getAllTools();
	const registered = new Set(tools.map((tool) => tool.name));
	const active = new Set(session.getActiveToolNames());
	for (const name of expectedTools) {
		assert.equal(
			registered.has(name),
			true,
			`${name} should remain registered`,
		);
		assert.equal(active.has(name), true, `${name} should remain active`);
		assert.equal(
			tools.find((tool) => tool.name === name)?.parameters
				?.additionalProperties,
			false,
			`${name} should reject undeclared properties`,
		);
	}
}

test("closed compatible tools prefer provider-supported strict sampling", () => {
	const tools: ToolDefinition[] = [];
	extension({
		on: () => {},
		registerTool: (tool: ToolDefinition) => tools.push(tool),
		registerCommand: () => {},
	} as unknown as ExtensionAPI);
	for (const name of ["subagent_run", "subagent_control", "workflow_control"]) {
		assert.deepEqual(
			tools.find((tool) => tool.name === name)?.constrainedSampling,
			{ type: "json_schema", strict: "prefer" },
		);
	}
	assert.equal(
		tools.find((tool) => tool.name === "workflow_run")?.constrainedSampling,
		undefined,
		"unconstrained workflow input is not strict-schema compatible",
	);
});

test("workflow engine adopts the current prototype without losing active state", () => {
	const engine = getWorkflowEngine(getRuntime());
	const state = engine as unknown as {
		active: Map<string, unknown>;
	};
	const active = state.active;
	const sentinel = {
		controller: new AbortController(),
		promise: new Promise(() => {}),
	};
	active.set("reload-sentinel", sentinel);
	try {
		Object.setPrototypeOf(engine, { legacy: true });
		const adopted = getWorkflowEngine(getRuntime());
		assert.equal(adopted, engine);
		assert.equal(Object.getPrototypeOf(adopted), WorkflowEngine.prototype);
		assert.equal(
			(adopted as unknown as { active: Map<string, unknown> }).active,
			active,
		);
		assert.equal(active.get("reload-sentinel"), sentinel);
	} finally {
		active.delete("reload-sentinel");
	}
});

test("package tools remain registered and active after reload", async () => {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-reload-"),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageRoot] }),
	);
	const settingsManager = SettingsManager.create(packageRoot, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: packageRoot,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: packageRoot,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			assertToolsRemainExposed(session);
			await session.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			assertToolsRemainExposed(session);
		} finally {
			session.dispose();
		}
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
