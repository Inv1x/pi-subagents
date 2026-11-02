import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { restoreChildSession } from "../src/child-session.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { RunStore } from "../src/run-store.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import { runSdkAgent } from "../src/sdk-transport.ts";
import type { ResolvedAgentRunRequest } from "../src/types.ts";

type Reply = {
	text?: string;
	tool?: { name: string; args: object };
	hang?: boolean;
};
async function fixture(
	respond: (
		body: { messages: Array<{ role: string; content: unknown }> },
		call: number,
	) => Reply,
) {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-sdk-child-test-"),
	);
	let calls = 0;
	const requests: unknown[] = [];
	const server = http.createServer(async (req, res) => {
		let body = "";
		for await (const chunk of req) body += chunk;
		const parsed = JSON.parse(body);
		requests.push(parsed);
		const reply = respond(parsed, ++calls);
		if (reply.hang) return;
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const delta = reply.tool
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `call-${calls}`,
							type: "function",
							function: {
								name: reply.tool.name,
								arguments: JSON.stringify(reply.tool.args),
							},
						},
					],
				}
			: { role: "assistant", content: reply.text ?? "" };
		res.write(
			`data: ${JSON.stringify({ id: `response-${calls}`, object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
		);
		res.write(
			`data: ${JSON.stringify({ id: `response-${calls}`, object: "chat.completion.chunk", model: "test", choices: [{ index: 0, delta: {}, finish_reason: reply.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	fs.writeFileSync(
		path.join(directory, "models.json"),
		JSON.stringify({
			providers: {
				"local-test": {
					baseUrl: `http://127.0.0.1:${port}/v1`,
					api: "openai-completions",
					apiKey: "offline-test-not-a-secret",
					models: [
						{
							id: "test",
							name: "Test",
							reasoning: false,
							input: ["text"],
							contextWindow: 100_000,
							maxTokens: 1000,
							cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	);
	fs.writeFileSync(
		path.join(directory, "settings.json"),
		JSON.stringify({
			cacheWarming: "off",
			compaction: { enabled: false },
			retry: { enabled: false },
		}),
	);
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousBin = process.env.PI_SUBAGENTS_PI_BIN;
	process.env.PI_CODING_AGENT_DIR = directory;
	delete process.env.PI_SUBAGENTS_PI_BIN;
	const runtime = new SubagentRuntime(
		new RunStore(path.join(directory, "runs")),
	);
	runtime.configure({ ...DEFAULT_CONFIG, maxRetries: 0 });
	const request: ResolvedAgentRunRequest = {
		agent: "test",
		task: "Remember ALPHA",
		background: false,
		context: "fresh",
		cwd: directory,
		workspace: "shared",
		timeoutMs: 20_000,
		maxTurns: 4,
		maxRetries: 0,
		difficulty: 2,
		model: "local-test/test",
		thinking: "off",
		systemPrompt: "Be concise.",
		definition: {
			name: "test",
			description: "test",
			systemPrompt: "Be concise.",
			source: "user",
			filePath: "test.md",
			tools: [],
			skills: [],
			context: "fresh",
			workspace: "shared",
			timeoutMs: 20_000,
			maxTurns: 4,
			inheritProjectContext: false,
			systemPromptMode: "replace",
		},
	};
	return {
		directory,
		runtime,
		request,
		requests,
		async dispose() {
			await runtime.shutdown();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			if (previousBin === undefined) delete process.env.PI_SUBAGENTS_PI_BIN;
			else process.env.PI_SUBAGENTS_PI_BIN = previousBin;
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			fs.rmSync(directory, { recursive: true, force: true });
		},
	};
}

test("SDK child persists canonical state and send schedules a separate invocation with history", async () => {
	const app = await fixture((_body, call) => ({
		text: call === 1 ? "ALPHA remembered" : "ALPHA recalled",
	}));
	try {
		const first = await app.runtime.startAgent(app.request, {
			background: false,
			sessionId: "parent",
		});
		assert.equal(first.state, "succeeded", first.error?.message ?? "");
		assert.match(first.output ?? "", /ALPHA remembered/);
		const resume = app.runtime.getContinuationRequest(
			first.id,
			"What do you remember?",
		);
		const second = await app.runtime.startAgent(resume, {
			background: false,
			sessionId: "parent",
		});
		assert.equal(second.state, "succeeded", second.error?.message ?? "");
		assert.notEqual(first.id, second.id);
		assert.equal(
			first.metadata?.childSessionId,
			second.metadata?.childSessionId,
		);
		assert.match(JSON.stringify(app.requests[1]), /ALPHA remembered/);
		assert.throws(
			() => app.runtime.getContinuationRequest(first.id, "duplicate"),
			/already has a follow-up/,
		);
		assert.throws(
			() => app.runtime.getContinuationRequest(second.id, " "),
			/nonblank/,
		);
		const file = path.join(app.runtime.store.runDir(second.id), "session.json");
		const restored = restoreChildSession(
			file,
			app.directory,
			String(second.metadata?.childSessionId),
		);
		assert.ok(
			restored
				.getEntries()
				.filter(
					(entry) =>
						entry.type === "message" && entry.message.role === "assistant",
				).length >= 2,
		);
		if (process.platform !== "win32")
			assert.equal(fs.statSync(file).mode & 0o777, 0o600);
		assert.equal(first.usage.turns, 1);
		assert.equal(second.usage.turns, 1, "prior usage is not charged again");
		const followup = app.runtime.getContinuationRequest(second.id, "continue");
		await assert.rejects(
			app.runtime.startAgent(followup, {
				background: true,
				sessionId: "other-parent",
			}),
			/another parent/,
		);
	} finally {
		await app.dispose();
	}
});

test("SDK host requests one tool-free final handoff within the turn limit", async () => {
	const app = await fixture((_body, call) =>
		call === 1
			? { tool: { name: "read", args: { path: "fixture.txt" } } }
			: { text: "Final handoff" },
	);
	fs.writeFileSync(path.join(app.directory, "fixture.txt"), "hello");
	try {
		const result = await app.runtime.startAgent(
			{
				...app.request,
				maxTurns: 2,
				definition: { ...app.request.definition, tools: ["read"] },
			},
			{ background: false, sessionId: "parent" },
		);
		assert.equal(result.state, "succeeded", result.error?.message ?? "");
		assert.equal(result.usage.turns, 2);
		assert.match(JSON.stringify(app.requests[1]), /final handoff/i);
		assert.equal(
			(app.requests[1] as { tools?: unknown[] }).tools?.length ?? 0,
			0,
		);
	} finally {
		await app.dispose();
	}
});

test("hard maxTurns exits cleanly after completed tools without an extra model request", async () => {
	const app = await fixture(() => ({
		tool: { name: "read", args: { path: "fixture.txt" } },
	}));
	fs.writeFileSync(path.join(app.directory, "fixture.txt"), "hello");
	try {
		const result = await app.runtime.startAgent(
			{
				...app.request,
				maxTurns: 1,
				definition: { ...app.request.definition, tools: ["read"] },
			},
			{ background: false, sessionId: "parent" },
		);
		assert.equal(result.state, "failed");
		assert.equal(result.error?.code, "max_turns");
		assert.equal(result.usage.turns, 1);
		assert.equal(app.requests.length, 1);
		assert.ok(
			fs.existsSync(
				path.join(app.runtime.store.runDir(result.id), "session.json"),
			),
		);
	} finally {
		await app.dispose();
	}
});

test("send reacquires writer leases and rejects parallel branches of a lineage", async () => {
	const app = await fixture(() => ({ text: "done" }));
	let release = () => {};
	try {
		const first = await app.runtime.startAgent(
			{
				...app.request,
				definition: { ...app.request.definition, tools: ["bash"] },
			},
			{ background: false, sessionId: "parent" },
		);
		assert.equal(first.state, "succeeded");
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started!: () => void;
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const blocker = app.runtime.scheduler.run(
			async () => {
				started();
				await held;
			},
			{
				priority: "foreground",
				resources: [`workspace-write:${fs.realpathSync(app.directory)}`],
			},
		);
		await ready;
		const resume = app.runtime.getContinuationRequest(first.id, "follow-up");
		const queued = await app.runtime.startAgent(resume, {
			background: true,
			sessionId: "parent",
		});
		assert.equal(queued.state, "queued");
		assert.equal(app.requests.length, 1);
		assert.throws(
			() => app.runtime.getContinuationRequest(first.id, "competing follow-up"),
			/already has a follow-up/,
		);
		assert.throws(
			() => app.runtime.getContinuationRequest(queued.id, "too early"),
			/settle/,
		);
		release();
		await blocker;
		assert.equal(
			(await app.runtime.wait(queued.id, 20_000)).state,
			"succeeded",
		);
	} finally {
		release();
		await app.dispose();
	}
});

test("worktree continuation restores its cumulative patch without touching the source checkout", async () => {
	const app = await fixture((_body, call) => {
		if (call === 1)
			return {
				tool: {
					name: "write",
					args: { path: "created.txt", content: "isolated output" },
				},
			};
		if (call === 3)
			return { tool: { name: "read", args: { path: "created.txt" } } };
		return { text: "worktree handoff" };
	});
	try {
		const repo = path.join(app.directory, "repo");
		fs.mkdirSync(repo);
		const git = (...args: string[]) =>
			execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
		git("init");
		git("config", "user.name", "Pi tests");
		git("config", "user.email", "pi-tests@example.invalid");
		fs.writeFileSync(path.join(repo, "base.txt"), "base");
		git("add", ".");
		git("-c", "commit.gpgsign=false", "commit", "-m", "base");
		const first = await app.runtime.startAgent(
			{
				...app.request,
				cwd: repo,
				workspace: "worktree",
				definition: { ...app.request.definition, tools: ["read", "write"] },
			},
			{ background: false, sessionId: "parent" },
		);
		assert.equal(first.state, "succeeded", first.error?.message ?? "");
		assert.ok(first.patchArtifact);
		assert.equal(fs.existsSync(path.join(repo, "created.txt")), false);
		const second = await app.runtime.startAgent(
			app.runtime.getContinuationRequest(
				first.id,
				"Read the file from your preceding invocation",
			),
			{ background: false, sessionId: "parent" },
		);
		assert.equal(second.state, "succeeded", second.error?.message ?? "");
		assert.match(JSON.stringify(app.requests[3]), /isolated output/);
		assert.match(
			fs.readFileSync(second.patchArtifact as string, "utf8"),
			/created.txt/,
		);
		assert.equal(fs.existsSync(path.join(repo, "created.txt")), false);
		assert.equal(git("status", "--porcelain").toString().trim(), "");
	} finally {
		await app.dispose();
	}
});

test("SDK startup failure exposes the missing Node executable and recovery guidance instead of EPIPE", async () => {
	const app = await fixture(() => ({ text: "must not be called" }));
	const descriptor = Object.getOwnPropertyDescriptor(process, "execPath");
	assert.ok(descriptor);
	const missingNode = path.join(
		app.directory,
		"removed-node",
		path.basename(process.execPath),
	);
	try {
		// A long-lived Pi process retains this path after a Homebrew Node upgrade.
		Object.defineProperty(process, "execPath", {
			...descriptor,
			value: missingNode,
		});
		const result = await app.runtime.startAgent(app.request, {
			background: false,
			sessionId: "parent",
		});
		assert.equal(result.state, "failed");
		assert.match(result.error?.message ?? "", /ENOENT/);
		assert.ok(result.error?.message.includes(missingNode));
		assert.match(result.error?.message ?? "", /restart Pi/i);
		assert.doesNotMatch(result.error?.message ?? "", /EPIPE/);
		assert.equal(result.output, result.error?.message);
		assert.equal(app.requests.length, 0);
		const persisted = app.runtime.store.read(result.id);
		assert.equal(persisted?.error?.message, result.error?.message);
	} finally {
		Object.defineProperty(process, "execPath", descriptor);
		await app.dispose();
	}
});

test("SDK transport cancellation and timeout reap the process without a success result", async () => {
	const app = await fixture(() => ({ hang: true }));
	try {
		for (const outcome of ["cancelled", "timed_out"] as const) {
			const controller = new AbortController();
			const directory = path.join(app.directory, outcome);
			fs.mkdirSync(directory);
			const pending = runSdkAgent({
				runId: `agent_${outcome}`,
				runDirectory: directory,
				request: {
					...app.request,
					timeoutMs: outcome === "timed_out" ? 250 : 20_000,
				},
				signal: controller.signal,
				resultMaxBytes: 4096,
				transcriptMaxEvents: 30,
			});
			if (outcome === "cancelled") setTimeout(() => controller.abort(), 250);
			const result = await pending;
			assert.equal(result.state, outcome);
			if (result.pid)
				assert.throws(() => process.kill(result.pid as number, 0));
		}
	} finally {
		await app.dispose();
	}
});
