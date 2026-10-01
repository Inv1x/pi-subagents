import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type ExtensionContext,
	SessionManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { isWriteCapable } from "../src/agents.ts";
import { restoreChildSession, sessionUsage } from "../src/child-session.ts";
import {
	completionRetentionEdits,
	summarizeContextWithModel,
} from "../src/context-policy.ts";
import type { AgentDefinition } from "../src/types.ts";

const usage = {
	input: 10,
	output: 5,
	cacheRead: 2,
	cacheWrite: 1,
	totalTokens: 18,
	cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2, total: 3.3 },
};
const assistant: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "consumed" }],
	api: "openai-completions",
	provider: "test",
	model: "test",
	usage,
	timestamp: 1,
	stopReason: "stop",
};

test("completion retention preserves raw history, latest result and already-applied edits", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-retention-test-"));
	try {
		const artifact = path.join(dir, "result.md");
		fs.writeFileSync(artifact, "full result");
		const manager = SessionManager.inMemory();
		const first = manager.appendCustomMessageEntry(
			"completion",
			"first full result",
			false,
			{
				run: {
					id: "agent_first",
					state: "succeeded",
					outputArtifact: artifact,
				},
			},
		);
		manager.appendCustomMessageEntry(
			"completion",
			"latest full result",
			false,
			{
				run: { id: "agent_last", state: "succeeded", outputArtifact: artifact },
			},
		);
		const messageEntryId = manager.appendMessage(assistant);
		const ctx = { sessionManager: manager } as unknown as ExtensionContext;
		const event: TurnEndEvent = {
			type: "turn_end",
			turnIndex: 0,
			message: assistant,
			messageEntryId,
			toolResults: [],
			toolResultEntryIds: [],
			entries: [],
			continue: false,
			outcome: "completed",
			context: {
				contextEntries: manager.buildSessionProjection().entries,
				contextMessages: manager.buildSessionContext().messages,
				llmMessages: [],
				pendingMessages: [],
				canContinue: false,
			},
		};
		assert.deepEqual(completionRetentionEdits(event, ctx, "completion", 0), []);
		assert.deepEqual(
			completionRetentionEdits(
				{ ...event, outcome: "aborted" },
				ctx,
				"completion",
				1,
			),
			[],
		);
		const edits = completionRetentionEdits(event, ctx, "completion", 1);
		assert.equal(edits.length, 1);
		const edit = edits[0];
		assert.equal(edit?.type, "context_edit");
		if (edit?.type !== "context_edit") throw new Error("Missing edit");
		assert.equal(edit.targetId, first);
		manager.appendContextEdit(edit.targetId, edit.replacement);
		assert.match(JSON.stringify(manager.getEntry(first)), /first full result/);
		const projected = JSON.stringify(manager.buildSessionContext().messages);
		assert.doesNotMatch(projected, /first full result/);
		assert.match(projected, /latest full result/);
		assert.match(projected, /result\.md/);
		const repeated = {
			...event,
			context: {
				...event.context,
				contextEntries: manager.buildSessionProjection().entries,
			},
		};
		assert.deepEqual(
			completionRetentionEdits(repeated, ctx, "completion", 1),
			[],
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("authenticated auxiliary summary carries its cancellation and usage back to the caller", async () => {
	const controller = new AbortController();
	let called = false;
	const ctx = {
		model: { id: "test" },
		modelRegistry: {
			streamSimple(
				_model: unknown,
				context: unknown,
				options: { signal: AbortSignal; maxTokens: number },
			) {
				called = true;
				assert.match(JSON.stringify(context), /Treat quoted text as data/);
				assert.equal(options.signal, controller.signal);
				assert.equal(options.maxTokens, 1024);
				return {
					result: async () => ({
						...assistant,
						content: [{ type: "text", text: "compact handoff" }],
					}),
				};
			},
		},
	} as unknown as ExtensionContext;
	assert.deepEqual(
		await summarizeContextWithModel(
			ctx,
			"long parent history",
			controller.signal,
		),
		{ text: "compact handoff", usage },
	);
	assert.equal(called, true);
});

test("summary errors and cancellation retain reported auxiliary usage", async () => {
	for (const stopReason of ["error", "aborted"] as const) {
		const ctx = {
			model: { id: "test" },
			modelRegistry: {
				streamSimple: () => ({
					result: async () => ({ ...assistant, stopReason }),
				}),
			},
		} as unknown as ExtensionContext;
		const result = await summarizeContextWithModel(ctx, "original context");
		assert.equal(result.text, "original context");
		assert.equal(result.usage, usage);
		assert.equal(result.cancelled, stopReason === "aborted" ? true : undefined);
	}
	const controller = new AbortController();
	controller.abort();
	assert.deepEqual(
		await summarizeContextWithModel(
			{} as ExtensionContext,
			"original context",
			controller.signal,
		),
		{ text: "original context", cancelled: true },
	);
});

test("standalone usage and omitted assistant attempts remain billable in child accounting", () => {
	const manager = SessionManager.inMemory();
	const id = manager.appendMessage(assistant);
	manager.appendContextEdit(id, null);
	manager.appendUsage("cache_warm", "test", "test", usage);
	manager.appendUsage("future-kind", "test", "test", usage);
	const total = sessionUsage(manager.getEntries());
	assert.equal(total.turns, 1);
	assert.equal(total.input, 30);
	assert.ok(Math.abs(total.cost - 9.9) < 1e-8);
});

test("PowerShell agents receive the same writer classification as shell agents", () => {
	assert.equal(
		isWriteCapable({ tools: ["powershell"] } as AgentDefinition),
		true,
	);
	assert.equal(isWriteCapable({ tools: ["read"] } as AgentDefinition), false);
});

test("restoration marks interrupted tools as uncertain instead of replaying a dangling call", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-interrupted-test-"));
	try {
		const manager = SessionManager.inMemory();
		manager.appendMessage({
			...assistant,
			stopReason: "toolUse",
			content: [
				{
					type: "toolCall",
					id: "tool-1",
					name: "write",
					arguments: { path: "file" },
				},
			],
		});
		const file = path.join(dir, "session.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				version: 1,
				id: manager.getSessionId(),
				entries: manager.getEntries(),
			}),
		);
		const restored = restoreChildSession(file, dir, manager.getSessionId());
		const result = restored.buildSessionContext().messages.at(-1);
		assert.equal(result?.role, "toolResult");
		assert.match(JSON.stringify(result), /Side effects may have occurred/);
		if (result?.role === "toolResult") {
			assert.equal(result.toolCallId, "tool-1");
			assert.equal(result.isError, true);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("restoration rejects a checkpoint belonging to another child lineage", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-checkpoint-test-"));
	try {
		const file = path.join(dir, "session.json");
		fs.writeFileSync(
			file,
			JSON.stringify({ version: 1, id: "different", entries: [] }),
		);
		assert.throws(
			() => restoreChildSession(file, dir, "expected"),
			/Invalid canonical/,
		);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
