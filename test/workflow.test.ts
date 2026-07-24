import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunStore } from "../src/run-store.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import type { AgentDefinition } from "../src/types.ts";
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

async function waitFor(
	predicate: () => boolean,
	timeoutMs = 3000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error("condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

test("workflow engine fans out, joins, gates, and persists stable steps", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-workflow-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconst value=(flag)=>process.argv[process.argv.indexOf(flag)+1];\nif(value('--model')!=='parent/model'||value('--thinking')!=='medium') process.exit(2);\nconst task=process.argv.at(-1);\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'done: '+task.slice(0,60)}],usage:{input:1,output:1,cost:{total:0.001}},provider:'parent',model:'model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
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
						task: "first",
					});
					const many = await ctx.map(
						"many",
						["a", "b"],
						(item) => ({ agent: "mock", task: item }),
						{ concurrency: 2 },
					);
					await ctx.gate("approval", {
						title: "approve",
						summary: first.output,
					});
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
				resolveAgent: (name) => (name === "mock" ? agent : undefined),
			},
		);
		await waitFor(() => runtime.get(started.id)?.state === "needs_input");
		const paused = runtime.store.readWorkflow(started.id);
		assert.equal(paused?.steps.approval?.state, "needs_input");
		assert.equal(
			Object.keys(paused?.steps ?? {}).filter((id) => id.startsWith("many."))
				.length,
			2,
		);
		engine.approve(started.id, "approval", true);
		const completed = await engine.wait(started.id, 5000);
		assert.equal(completed.state, "succeeded");
		assert.match(completed.output ?? "", /done: Task: first/);
		assert.equal(
			runtime.list(100).filter((record) => record.parentRunId === started.id)
				.length,
			3,
		);
		assert.equal(
			runtime.store.readWorkflow(started.id)?.steps.approval?.state,
			"succeeded",
		);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
