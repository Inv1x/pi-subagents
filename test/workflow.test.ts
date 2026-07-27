import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
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
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		assert.equal(resumed.state, "succeeded");
		assert.equal(
			runtime.store.readWorkflow(resumed.id)?.routing?.defaultModel,
			"old/model",
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
