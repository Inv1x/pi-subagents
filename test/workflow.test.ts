import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { Type } from "typebox";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunStore } from "../src/run-store.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import type { AgentDefinition, WorkflowRoutingSnapshot } from "../src/types.ts";
import type { DiscoveredWorkflow } from "../src/workflows.ts";
import { WorkflowEngine } from "../src/workflows.ts";

function definition(filePath: string): AgentDefinition {
	return {
		name: "mock",
		description: "mock",
		systemPrompt: "mock",
		tools: [],
		context: "fresh",
		workspace: "shared",
		maxTurns: 2,
		timeoutMs: 5000,
		skills: [],
		systemPromptMode: "replace",
		inheritProjectContext: false,
		source: "user",
		filePath,
	};
}

test("workflow engine fans out, joins, and persists stable steps", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconst value=(flag)=>process.argv[process.argv.indexOf(flag)+1];\nif(value('--model')!=='routed/model'||value('--thinking')!=='high') process.exit(2);\nconst task=process.argv.at(-1);\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done: '+task.slice(0,60)}],usage:{input:1,output:1,cost:{total:0.001}},provider:'routed',model:'model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		runtime.configure({
			...DEFAULT_CONFIG,
			maxConcurrency: 2,
			maxWorkflowConcurrency: 2,
		});
		const engine = new WorkflowEngine(runtime);
		const agent = definition(script);
		const routedDifficulties: number[] = [];
		const workflow: DiscoveredWorkflow = {
			source: "user",
			filePath: path.join(directory, "test.workflow.ts"),
			definitionHash: "fixed-hash",
			definition: {
				name: "test-flow",
				description: "test",
				async run(ctx) {
					const first = await ctx.agent("first", {
						agent: "mock",
						context: "summary",
						difficulty: 4,
						task: "first",
					});
					const many = await ctx.map(
						"many",
						["a", "b"],
						(item) => ({ agent: "mock", difficulty: 2, task: item }),
						{ concurrency: 2 },
					);
					return { first: first.output, many: many.map((item) => item.output) };
				},
			},
		};
		const started = await engine.start(
			workflow,
			{ request: "test" },
			{
				cwd: directory,
				background: true,
				contextSummary: "bounded parent summary",
				defaultModel: "parent/model",
				defaultThinking: "medium",
				routing: {
					defaultModel: "parent/model",
					defaultThinking: "medium",
					agentModels: {},
					agents: { mock: agent },
				},
				resolveAgentRoute: (_definition, spec) => {
					routedDifficulties.push(spec.difficulty ?? 3);
					return {
						difficulty: spec.difficulty ?? 3,
						model: "routed/model",
						thinking: "high",
						profile: {
							model: "routed/model",
							thinking: "high",
							maxDifficulty: 5,
						},
					};
				},
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		const completed = await engine.wait(started.id, 5000);
		const snapshot = runtime.store.readWorkflow(started.id);
		assert.equal(
			Object.keys(snapshot?.steps ?? {}).filter((id) => id.startsWith("many."))
				.length,
			2,
		);
		assert.equal(completed.state, "succeeded");
		assert.equal(snapshot?.routing?.defaultModel, "parent/model");
		assert.equal(snapshot?.routing?.defaultThinking, "medium");
		assert.match(completed.output ?? "", /done: Task: first/);
		assert.deepEqual(routedDifficulties.sort(), [2, 2, 4]);
		const children = runtime
			.list(100)
			.filter((record) => record.parentRunId === started.id);
		assert.equal(children.length, 3);
		assert.deepEqual(
			children.map((record) => record.model),
			["routed/model", "routed/model", "routed/model"],
		);
		assert.match(
			children.find((record) => record.stepId === "first")?.task ?? "",
			/<workflow_context>\nbounded parent summary/,
		);
		assert.deepEqual(
			children.map((record) => record.difficulty).sort(),
			[2, 2, 4],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("workflow resume keeps the original routing snapshot", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-resume-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	const counter = path.join(directory, "counter");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nimport fs from 'node:fs';\nconst value=(flag)=>process.argv[process.argv.indexOf(flag)+1];\nif(value('--model')!=='old/model') process.exit(2);\nconst counter=${JSON.stringify(counter)};\nconst attempt=fs.existsSync(counter)?2:1;\nfs.writeFileSync(counter,String(attempt));\nif(attempt===1) console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],usage:{input:1,output:1,cost:{total:0.001}},provider:'old',model:'model',stopReason:'error',errorMessage:'first attempt fails',timestamp:Date.now()}}));\nelse console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'resumed'}],usage:{input:1,output:1,cost:{total:0.001}},provider:'old',model:'model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		runtime.configure({ ...DEFAULT_CONFIG, maxRetries: 0 });
		const engine = new WorkflowEngine(runtime);
		const agent = definition(script);
		const workflow: DiscoveredWorkflow = {
			source: "user",
			filePath: path.join(directory, "resume.workflow.ts"),
			definitionHash: "resume-hash",
			definition: {
				name: "resume-flow",
				description: "test",
				async run(ctx) {
					return (await ctx.agent("only", { agent: "mock", task: "resume" }))
						.output;
				},
			},
		};
		const oldRouting = {
			defaultModel: "old/model",
			defaultThinking: "medium" as const,
			scopedModels: ["old/model"],
			agentModels: {},
			agents: { mock: agent },
		};
		const route = (
			_routing: WorkflowRoutingSnapshot | undefined,
		): {
			difficulty: 3;
			model: string;
			thinking: "medium";
		} => ({
			difficulty: 3,
			model: _routing?.defaultModel ?? "new/model",
			thinking: "medium",
		});
		const failed = await engine.start(
			workflow,
			{},
			{
				cwd: directory,
				background: false,
				routing: oldRouting,
				resolveAgentRoute: (_definition, _spec, routing) => route(routing),
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(failed.state, "failed");

		let validatedSavedRoutes = 0;
		const resumed = await engine.start(
			workflow,
			{},
			{
				cwd: directory,
				background: false,
				existingRunId: failed.id,
				routing: {
					defaultModel: "new/model",
					defaultThinking: "high",
					agentModels: {},
					agents: { mock: { ...agent, model: "new/model" } },
				},
				resolveAgentRoute: (_definition, _spec, routing) => route(routing),
				validateAgentRoute: (savedRoute, routing) => {
					validatedSavedRoutes++;
					assert.deepEqual(routing?.scopedModels, ["old/model"]);
					assert.equal(savedRoute.model, "old/model");
					return savedRoute;
				},
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(resumed.state, "succeeded");
		assert.equal(validatedSavedRoutes, 1);
		assert.equal(
			runtime.store.readWorkflow(resumed.id)?.routing?.defaultModel,
			"old/model",
		);
		assert.deepEqual(
			runtime.store.readWorkflow(resumed.id)?.routing?.scopedModels,
			["old/model"],
		);
		assert.deepEqual(
			runtime
				.list(100)
				.filter((record) => record.parentRunId === resumed.id)
				.map((record) => record.model),
			["old/model", "old/model"],
		);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("workflow fallback preserves undefined defaults from pinned routing", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-undefined-route-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nif(process.argv.includes('--model')||process.argv.includes('--thinking')) process.exit(2);\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'unpinned default'}],usage:{input:1,output:1,cost:{total:0}},provider:'mock',model:'default',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const engine = new WorkflowEngine(runtime);
		const agent = definition(script);
		const workflow: DiscoveredWorkflow = {
			source: "user",
			filePath: path.join(directory, "undefined.workflow.ts"),
			definitionHash: "undefined-route-hash",
			definition: {
				name: "undefined-route",
				description: "test",
				async run(ctx) {
					return (await ctx.agent("only", { agent: "mock", task: "test" }))
						.output;
				},
			},
		};
		const completed = await engine.start(
			workflow,
			{},
			{
				cwd: directory,
				background: false,
				defaultModel: "current/model",
				defaultThinking: "high",
				routing: {
					defaultModel: undefined,
					defaultThinking: undefined,
					agentModels: {},
					agents: { mock: agent },
				},
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(completed.state, "succeeded");
		const route = runtime.store.readWorkflow(completed.id)?.steps.only?.metadata
			?.route as { model?: string; thinking?: string } | undefined;
		assert.equal(route?.model, undefined);
		assert.equal(route?.thinking, undefined);

		const outsideScope = await engine.start(
			workflow,
			{},
			{
				cwd: directory,
				background: false,
				routing: {
					defaultModel: "outside/model",
					scopedModels: ["allowed/model"],
					agentModels: {},
					agents: { mock: agent },
				},
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(outsideScope.state, "failed");
		assert.match(outsideScope.error?.message ?? "", /outside the pinned/);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("workflow validates declared input before running user code", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-schema-"),
	);
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const engine = new WorkflowEngine(runtime);
		let executed = false;
		const workflow: DiscoveredWorkflow = {
			source: "user",
			filePath: path.join(directory, "schema.workflow.ts"),
			definitionHash: "schema-hash",
			definition: {
				name: "schema-flow",
				description: "test",
				input: Type.Object(
					{ request: Type.String() },
					{ additionalProperties: false },
				),
				output: Type.String(),
				run() {
					executed = true;
					return "ok";
				},
			},
		};
		await assert.rejects(
			engine.start(
				workflow,
				{ request: 42 },
				{ cwd: directory, background: false, resolveAgent: () => undefined },
			),
			/does not match its declared schema/,
		);
		assert.equal(executed, false);
		assert.equal(runtime.list(10).length, 0);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("workflow rejects invalid workspace before creating a child", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-invalid-"),
	);
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const engine = new WorkflowEngine(runtime);
		const agent = definition(path.join(directory, "unused"));
		const workflow: DiscoveredWorkflow = {
			source: "user",
			filePath: path.join(directory, "invalid.workflow.ts"),
			definitionHash: "invalid-hash",
			definition: {
				name: "invalid-flow",
				description: "test",
				async run(ctx) {
					return ctx.agent("invalid", {
						agent: "mock",
						task: "invalid workspace",
						workspace: "share" as never,
					});
				},
			},
		};
		const completed = await engine.start(
			workflow,
			{},
			{
				cwd: directory,
				background: false,
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(completed.state, "failed");
		assert.match(completed.error?.message ?? "", /Invalid workflow workspace/);
		assert.equal(
			runtime.list(100).filter((record) => record.parentRunId === completed.id)
				.length,
			0,
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("background workflows durably fail for non-JSON results", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-json-result-"),
	);
	const unhandled: unknown[] = [];
	const onUnhandled = (reason: unknown) => unhandled.push(reason);
	process.on("unhandledRejection", onUnhandled);
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const engine = new WorkflowEngine(runtime);
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const [name, value] of [
			["cyclic-result", cyclic],
			["bigint-result", 1n],
		] as const) {
			const workflow: DiscoveredWorkflow = {
				source: "user",
				filePath: path.join(directory, `${name}.workflow.ts`),
				definitionHash: `${name}-hash`,
				definition: {
					name,
					description: "test",
					run: () => value,
				},
			};
			const started = await engine.start(
				workflow,
				{},
				{
					cwd: directory,
					background: true,
					resolveAgent: () => undefined,
				},
			);
			const completed = await engine.wait(started.id, 5000);
			assert.equal(completed.state, "failed");
			assert.match(completed.error?.message ?? "", /not JSON-serializable/);
			assert.equal(runtime.store.read(started.id)?.state, "failed");
			const snapshot = runtime.store.readWorkflow(started.id);
			assert.equal(snapshot?.state, "failed");
			assert.equal(
				Object.hasOwn(snapshot ?? {}, "result"),
				false,
				"invalid result must not poison the persisted snapshot",
			);
		}
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(unhandled, []);
	} finally {
		process.off("unhandledRejection", onUnhandled);
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("non-fail-fast maps preserve failed child diagnostics", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-map-failure-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconst task=process.argv.at(-1);\nconst failing=task.includes('FAIL');\nconst message={role:'assistant',content:[{type:'text',text:failing?'FAILED_DIAGNOSTIC':'OK'}],usage:{input:failing?7:2,output:3,cost:{total:failing?0.07:0.02}},provider:'mock',model:'model',stopReason:failing?'error':'stop',timestamp:Date.now()};\nif(failing) message.errorMessage='child exploded';\nconsole.log(JSON.stringify({type:'message_end',message}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		runtime.configure({ ...DEFAULT_CONFIG, maxRetries: 0 });
		const engine = new WorkflowEngine(runtime);
		const agent = definition(script);
		const workflow: DiscoveredWorkflow = {
			source: "user",
			filePath: path.join(directory, "map-failure.workflow.ts"),
			definitionHash: "map-failure-hash",
			definition: {
				name: "map-failure",
				description: "test",
				async run(ctx) {
					return ctx.map(
						"checks",
						["PASS", "FAIL"],
						(task) => ({ agent: "mock", task }),
						{ concurrency: 2, failFast: false },
					);
				},
			},
		};
		const completed = await engine.start(
			workflow,
			{},
			{
				cwd: directory,
				background: false,
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(completed.state, "succeeded");
		const children = runtime
			.list(100)
			.filter((record) => record.parentRunId === completed.id);
		const failedChild = children.find((record) => record.state === "failed");
		assert.ok(failedChild);
		const snapshot = runtime.store.readWorkflow(completed.id);
		const results = snapshot?.steps.checks?.result as
			| Array<{
					runId: string;
					state: string;
					output: string;
					outputArtifact?: string;
					usage: { input: number; output: number; cost: number };
			  }>
			| undefined;
		const failedResult = results?.find((result) => result.state === "failed");
		assert.ok(failedResult);
		assert.equal(failedResult.runId, failedChild.id);
		assert.equal(failedResult.outputArtifact, failedChild.outputArtifact);
		assert.equal(failedResult.usage.input, 7);
		assert.equal(failedResult.usage.output, 3);
		assert.equal(failedResult.usage.cost, 0.07);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
