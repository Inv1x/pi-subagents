import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runCliAgent } from "../src/transport.ts";
import type { AgentDefinition, ResolvedAgentRunRequest } from "../src/types.ts";

function agent(filePath: string): AgentDefinition {
	return {
		name: "mock",
		description: "mock",
		systemPrompt: "mock",
		tools: ["read"],
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

test("CLI transport parses events, activity, usage, and output", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-transport-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconst value=(flag)=>process.argv[process.argv.indexOf(flag)+1];\nif(value('--model')!=='requested/model'||value('--thinking')!=='high'||!process.argv.includes('--no-skills')) process.exit(2);\nconsole.log(JSON.stringify({type:'session',version:3,id:'s',cwd:process.cwd()}));\nconsole.log(JSON.stringify({type:'tool_execution_start',toolName:'read',args:{path:'src/a.ts'}}));\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Mock result'}],usage:{input:10,output:4,cacheRead:2,cacheWrite:1,totalTokens:17,cost:{total:0.01}},provider:'requested',model:'model',responseModel:'actual-model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const request: ResolvedAgentRunRequest = {
			agent: definition.name,
			task: "test",
			definition,
			difficulty: 3,
			background: false,
			context: "fresh",
			cwd: directory,
			workspace: "shared",
			timeoutMs: 5000,
			maxTurns: 3,
			model: "requested/model",
			thinking: "high",
			systemPrompt: "mock",
		};
		const events: string[] = [];
		const result = await runCliAgent({
			runId: "agent_123456",
			runDirectory: directory,
			request,
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
			onEvent: (event) => events.push(event.type),
		});
		assert.equal(result.state, "succeeded");
		assert.equal(result.output, "Mock result");
		assert.equal(result.usage.input, 10);
		assert.equal(result.usage.cost, 0.01);
		assert.equal(result.model, "requested/actual-model");
		assert.ok(events.includes("activity"));
		assert.ok(events.includes("settled"));
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI transport ignores Pi 0.84 deltas and trusts message_end", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-delta-fixture-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	const fixture = path.resolve("test/fixtures/pi-0.84-delta-only.jsonl");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const events: string[] = [];
		const result = await runCliAgent({
			runId: "agent_delta_fixture",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 5000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
			onEvent: (event) => events.push(event.type),
		});
		assert.equal(result.state, "succeeded");
		assert.equal(result.output, "Authoritative final");
		assert.deepEqual(events, ["started", "usage", "settled"]);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI transport strips parent session and model environment", async () => {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-env-"));
	const script = path.join(directory, "mock-pi.mjs");
	const inherited = [
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
	];
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconst keys=${JSON.stringify(inherited)};const leaked=keys.filter((key)=>process.env[key]!==undefined);console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:leaked.length?'leaked: '+leaked.join(','):'clean env'}],usage:{input:1,output:1,cost:{total:0}},provider:'fixture',model:'model',stopReason:'stop'}}));console.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previousBin = process.env.PI_SUBAGENTS_PI_BIN;
	const previousValues = new Map(
		inherited.map((key) => [key, process.env[key]]),
	);
	process.env.PI_SUBAGENTS_PI_BIN = script;
	for (const key of inherited) process.env[key] = "parent-value";
	try {
		const definition = agent(script);
		const result = await runCliAgent({
			runId: "agent_env",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 5000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
		});
		assert.equal(result.state, "succeeded");
		assert.equal(result.output, "clean env");
	} finally {
		if (previousBin === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previousBin;
		for (const [key, value] of previousValues) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI transport reports malformed assistant usage without crashing", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-malformed-message-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'bad'}],usage:{input:'not-a-number'},stopReason:'stop'}}));console.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const result = await runCliAgent({
			runId: "agent_malformed",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 5000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.error?.code, "malformed_message_end");
		assert.match(result.error?.message ?? "", /usage\.input/);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("POSIX cancellation escalates the entire child process group", {
	skip: process.platform === "win32",
}, async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-process-group-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	const pidFile = path.join(directory, "grandchild.pid");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nimport fs from 'node:fs';import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000);\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const controller = new AbortController();
		const pending = runCliAgent({
			runId: "agent_process_group",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 10_000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: controller.signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
		});
		for (let attempt = 0; attempt < 300 && !fs.existsSync(pidFile); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fs.existsSync(pidFile), true);
		const descendantPid = Number(fs.readFileSync(pidFile, "utf8"));
		const cancelledAt = Date.now();
		controller.abort(new Error("test cancellation"));
		const result = await pending;
		assert.equal(result.state, "cancelled");
		assert.ok(
			Date.now() - cancelledAt < 2500,
			"leader close should end the grace period before escalation",
		);
		assert.throws(
			() => process.kill(descendantPid, 0),
			"runCliAgent must not resolve while a descendant remains",
		);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("POSIX cooperative cancellation does not wait out the grace period", {
	skip: process.platform === "win32",
}, async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-cooperative-exit-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	const readyFile = path.join(directory, "ready");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nimport fs from 'node:fs';fs.writeFileSync(${JSON.stringify(readyFile)},'ready');setInterval(()=>{},1000);\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const controller = new AbortController();
		const pending = runCliAgent({
			runId: "agent_cooperative_exit",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 10_000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: controller.signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
		});
		for (let attempt = 0; attempt < 300 && !fs.existsSync(readyFile); attempt++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(fs.existsSync(readyFile), true);
		const cancelledAt = Date.now();
		controller.abort(new Error("test cancellation"));
		const result = await pending;
		assert.equal(result.state, "cancelled");
		assert.ok(Date.now() - cancelledAt < 2500);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI transport rejects zero exits without complete settlement", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-incomplete-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	const fixture = path.resolve(
		"test/fixtures/pi-0.84-missing-settlement.jsonl",
	);
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nimport fs from 'node:fs';\nprocess.stdout.write(fs.readFileSync(${JSON.stringify(fixture)}, 'utf8'));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const result = await runCliAgent({
			runId: "agent_incomplete",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 5000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.error?.code, "incomplete_child_protocol");
		assert.match(result.error?.message ?? "", /agent_settled/);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI transport fails instead of silently using a different model", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-model-mismatch-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Wrong model'}],usage:{input:1,output:1,cost:{total:0.01}},provider:'openai-codex',model:'gpt-5.6-sol',stopReason:'stop',timestamp:Date.now()}}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const result = await runCliAgent({
			runId: "agent_model_mismatch",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 5000,
				maxTurns: 3,
				model: "openai-codex/gpt-5.6-luna",
				thinking: "xhigh",
				systemPrompt: "mock",
			},
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
		});
		assert.equal(result.state, "failed");
		assert.equal(result.error?.code, "model_mismatch");
		assert.match(result.error?.message ?? "", /luna.*reported.*sol/);
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("CLI transport clears a transient model error after Pi's internal retry succeeds", async () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-provider-retry-"),
	);
	const script = path.join(directory, "mock-pi.mjs");
	fs.writeFileSync(
		script,
		`#!/usr/bin/env node\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[],usage:{input:10,output:1,cost:{total:0.1}},provider:'mock',model:'model',stopReason:'error',errorMessage:'WebSocket error',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'auto_retry_start',attempt:1,maxAttempts:3,delayMs:1,errorMessage:'WebSocket error'}));\nconsole.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Recovered internally'}],usage:{input:5,output:2,cost:{total:0.02}},provider:'mock',model:'model',stopReason:'stop',timestamp:Date.now()}}));\nconsole.log(JSON.stringify({type:'auto_retry_end',success:true,attempt:1}));\nconsole.log(JSON.stringify({type:'agent_settled'}));\n`,
	);
	fs.chmodSync(script, 0o755);
	const previous = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_SUBAGENTS_PI_BIN = script;
	try {
		const definition = agent(script);
		const events: string[] = [];
		const result = await runCliAgent({
			runId: "agent_provider_retry",
			runDirectory: directory,
			request: {
				agent: definition.name,
				task: "test",
				definition,
				difficulty: 3,
				background: false,
				context: "fresh",
				cwd: directory,
				workspace: "shared",
				timeoutMs: 5000,
				maxTurns: 3,
				systemPrompt: "mock",
			},
			signal: new AbortController().signal,
			resultMaxBytes: 1024,
			transcriptMaxEvents: 20,
			onEvent: (event) => events.push(event.type),
		});
		assert.equal(result.state, "succeeded");
		assert.equal(result.output, "Recovered internally");
		assert.equal(result.usage.input, 15);
		assert.equal(result.usage.cost, 0.12000000000000001);
		assert.ok(events.includes("retry"));
	} finally {
		if (previous === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
		else process.env.PI_SUBAGENTS_PI_BIN = previous;
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
