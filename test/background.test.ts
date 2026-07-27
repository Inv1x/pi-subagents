import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { RunStore } from "../src/run-store.ts";
import { getRuntime, SubagentRuntime } from "../src/runtime.ts";
import {
	type AgentDefinition,
	type ResolvedAgentRunRequest,
	TERMINAL_STATES,
} from "../src/types.ts";

function definition(filePath: string): AgentDefinition {
	return {
		name: "background-mock",
		description: "background smoke test",
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

test("hot reload adopts the current runtime prototype without losing state", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-hot-reload-"),
	);
	const symbol = Symbol.for("pi-subagents.runtime.v1");
	const globals = globalThis as typeof globalThis & {
		[symbol]?: SubagentRuntime;
	};
	const previous = globals[symbol];
	try {
		const retained = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		Object.setPrototypeOf(retained, {});
		delete (retained as unknown as { detachments?: unknown }).detachments;
		globals[symbol] = retained;

		const adopted = getRuntime();
		assert.equal(adopted, retained);
		assert.equal(typeof adopted.listForSession, "function");
		assert.equal(typeof adopted.background, "function");
		assert.ok(
			(adopted as unknown as { detachments?: Map<string, unknown> })
				.detachments instanceof Map,
		);
	} finally {
		if (previous) globals[symbol] = previous;
		else delete globals[symbol];
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("background subagent returns immediately and completes independently", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-background-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nawait new Promise((resolve) => setTimeout(resolve, 200));\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'BACKGROUND_OK'}],usage:{input:1,output:1,cost:{total:0.001}},model:'mock/model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const agent = definition(script);
		const request: ResolvedAgentRunRequest = {
			agent: "task-auditor",
			baseAgent: agent.name,
			task: "background smoke test",
			definition: agent,
			difficulty: 3,
			background: true,
			context: "fresh",
			cwd: directory,
			workspace: "shared",
			timeoutMs: 5000,
			maxTurns: 2,
			systemPrompt: "mock",
		};
		const started = await runtime.startAgent(request, {
			background: true,
			sessionId: "session-a",
		});
		assert.equal(started.background, true);
		assert.equal(started.agent, "task-auditor");
		assert.equal(started.metadata?.baseAgent, "background-mock");
		assert.equal(TERMINAL_STATES.has(started.state), false);

		const completed = await runtime.wait(started.id, 5000);
		assert.equal(completed.state, "succeeded");
		assert.equal(completed.output, "BACKGROUND_OK");
		assert.deepEqual(
			runtime.listForSession("session-a").map((record) => record.id),
			[started.id],
		);
		assert.equal(runtime.getForSession(started.id, "session-b"), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("foreground standalone subagent can be manually backgrounded", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-manual-background-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nawait new Promise((resolve) => setTimeout(resolve, 500));\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'DETACHED_OK'}],usage:{input:1,output:1,cost:{total:0.001}},model:'mock/model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const agent = definition(script);
		const request: ResolvedAgentRunRequest = {
			agent: "manual-background",
			baseAgent: agent.name,
			task: "manual background smoke test",
			definition: agent,
			difficulty: 3,
			background: false,
			context: "fresh",
			cwd: directory,
			workspace: "shared",
			timeoutMs: 5000,
			maxTurns: 2,
			systemPrompt: "mock",
		};
		let createdId = "";
		const foreground = runtime.startAgent(request, {
			background: false,
			sessionId: "session-a",
			onCreated: (record) => {
				createdId = record.id;
			},
		});
		assert.ok(createdId);
		const detached = runtime.background(createdId, "session-a");
		assert.equal(detached.background, true);

		const returned = await foreground;
		assert.equal(returned.background, true);
		assert.equal(TERMINAL_STATES.has(returned.state), false);

		const completed = await runtime.wait(createdId, 5000);
		assert.equal(completed.state, "succeeded");
		assert.equal(completed.output, "DETACHED_OK");
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
