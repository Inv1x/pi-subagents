import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunStore } from "../src/run-store.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import type { AgentDefinition, ResolvedAgentRunRequest } from "../src/types.ts";

function definition(filePath: string, tools: string[]): AgentDefinition {
	return {
		name: "retry-mock",
		description: "retry smoke test",
		systemPrompt: "mock",
		tools,
		context: "fresh",
		workspace: "shared",
		maxTurns: 3,
		timeoutMs: 5000,
		skills: [],
		systemPromptMode: "replace",
		inheritProjectContext: false,
		source: "user",
		filePath,
	};
}

function request(agent: AgentDefinition): ResolvedAgentRunRequest {
	return {
		agent: agent.name,
		task: "retry test",
		definition: agent,
		difficulty: 3,
		background: false,
		context: "fresh",
		cwd: path.dirname(agent.filePath),
		workspace: "shared",
		timeoutMs: 5000,
		maxTurns: 3,
		maxRetries: 2,
		systemPrompt: "mock",
	};
}

test("runtime retries transient transport failures and preserves cumulative usage", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-retry-"),
	);
	const counter = path.join(directory, "attempts.txt");
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nimport fs from 'node:fs';\nconst counter=${JSON.stringify(counter)};\nconst attempt=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;\nfs.writeFileSync(counter,String(attempt));\nif(attempt===1){\n console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],usage:{input:10,output:1,cost:{total:0.1}},provider:'mock',model:'model',stopReason:'error',errorMessage:'WebSocket error',timestamp:Date.now()}}));\n}else{\n console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'recovered'}],usage:{input:5,output:2,cost:{total:0.02}},provider:'mock',model:'model',stopReason:'stop',timestamp:Date.now()}}));\n}\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		runtime.configure({ ...DEFAULT_CONFIG, retryBaseDelayMs: 1 });
		const completed = await runtime.startAgent(
			request(definition(script, ["read"])),
			{ background: false },
		);
		assert.equal(completed.state, "succeeded");
		assert.equal(completed.output, "recovered");
		assert.equal(completed.metadata?.attempt, 2);
		assert.equal(completed.metadata?.retryCount, 1);
		assert.equal(completed.usage.input, 15);
		assert.equal(completed.usage.output, 3);
		assert.equal(completed.usage.cost, 0.12000000000000001);
		assert.equal(fs.readFileSync(counter, "utf8"), "2");
		assert.ok(completed.transcriptArtifact);
		assert.match(
			fs.readFileSync(completed.transcriptArtifact, "utf8"),
			/WebSocket error/,
		);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

for (const tool of ["bash", "powershell", "edit", "write"]) {
	test(`runtime does not restart a child after ${tool}`, async () => {
		const directory = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-subagents-no-write-retry-"),
		);
		const counter = path.join(directory, "attempts.txt");
		const script = path.join(directory, "mock-pi.mjs");
		fs.writeFileSync(
			script,
			`#!/usr/bin/env node\nimport fs from 'node:fs';\nconst counter=${JSON.stringify(counter)};\nconst attempt=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;\nfs.writeFileSync(counter,String(attempt));\nconsole.log(JSON.stringify({type:'tool_execution_start',toolName:${JSON.stringify(tool)},args:{path:'changed.txt'}}));\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],usage:{input:1,output:1,cost:{total:0.01}},provider:'mock',model:'model',stopReason:'error',errorMessage:'WebSocket error',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
		);
		fs.chmodSync(script, 0o755);
		const previous = process.env.PI_SUBAGENTS_PI_BIN;
		process.env.PI_SUBAGENTS_PI_BIN = script;
		try {
			const runtime = new SubagentRuntime(
				new RunStore(path.join(directory, "runs")),
			);
			runtime.configure({ ...DEFAULT_CONFIG, retryBaseDelayMs: 1 });
			const completed = await runtime.startAgent(
				request(definition(script, [tool])),
				{ background: false },
			);
			assert.equal(completed.state, "failed");
			assert.equal(completed.error?.message, "WebSocket error");
			assert.equal(completed.metadata?.attempt, 1);
			assert.equal(fs.readFileSync(counter, "utf8"), "1");
		} finally {
			if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
			else process.env.PI_SUBAGENTS_PI_BIN = previous;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
}
