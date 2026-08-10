import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	reconcileBackgroundCompletions,
	sendBackgroundCompletion,
} from "../src/index.ts";
import { RunStore } from "../src/run-store.ts";
import { SubagentRuntime } from "../src/runtime.ts";
import type { RunRecord } from "../src/types.ts";

function completedRun(patch: Partial<RunRecord> = {}): RunRecord {
	const now = Date.now();
	return {
		version: 1,
		id: "agent_completion",
		kind: "agent",
		state: "succeeded",
		background: true,
		sessionId: "session-a",
		agent: "background-reviewer",
		cwd: "/tmp/project",
		workspace: "shared",
		createdAt: now - 1000,
		updatedAt: now,
		endedAt: now,
		usage: {
			turns: 1,
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.01,
			contextTokens: 15,
		},
		output: "Review complete.",
		metadata: { completionPending: true },
		...patch,
	};
}

test("background completion is a model-visible follow-up that triggers a turn", () => {
	const calls: Array<{ message: unknown; options: unknown }> = [];
	const pi = {
		sendMessage: (message: unknown, options: unknown) => {
			calls.push({ message, options });
		},
	} as unknown as Pick<ExtensionAPI, "sendMessage">;
	const run = completedRun();

	sendBackgroundCompletion(pi, run);

	assert.equal(calls.length, 1);
	assert.deepEqual(calls[0]?.options, {
		deliverAs: "followUp",
		triggerTurn: true,
	});
	assert.deepEqual(calls[0]?.message, {
		customType: "pi-subagents-completion",
		content:
			"Background subagent background-reviewer succeeded [agent_completion].\n\nReview complete.",
		display: false,
		details: { run },
	});
});

test("workflow failures include their error in the parent completion", () => {
	let message: { content?: unknown } | undefined;
	const pi = {
		sendMessage: (next: { content?: unknown }) => {
			message = next;
		},
	} as unknown as Pick<ExtensionAPI, "sendMessage">;
	const run = completedRun({
		id: "workflow_completion",
		kind: "workflow",
		agent: undefined,
		workflow: "parallel-review",
		state: "failed",
		output: undefined,
		error: {
			code: "workflow_error",
			message: "A review failed.",
			retryable: true,
		},
	});

	sendBackgroundCompletion(pi, run);

	assert.equal(
		message?.content,
		"Background workflow parallel-review failed [workflow_completion].\n\nA review failed.",
	);
});

test("completion reconciliation acknowledges persisted messages and retries lost queues", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-completion-"),
	);
	try {
		const runtime = new SubagentRuntime(
			new RunStore(path.join(directory, "runs")),
		);
		const persisted = runtime.createWorkflowRecord(
			"persisted",
			{},
			{
				cwd: directory,
				sessionId: "session-a",
				background: true,
			},
		);
		runtime.updateManagedRun(persisted.id, "succeeded", { output: "done" });
		runtime.markCompletionEnqueued(persisted.id, "session-a");

		const lost = runtime.createWorkflowRecord(
			"lost",
			{},
			{
				cwd: directory,
				sessionId: "session-a",
				background: true,
			},
		);
		runtime.updateManagedRun(lost.id, "succeeded", { output: "done" });
		runtime.markCompletionEnqueued(lost.id, "session-a");

		const ctx = {
			sessionManager: {
				getSessionId: () => "session-a",
				getBranch: () => [
					{
						type: "custom_message",
						customType: "pi-subagents-completion",
						details: {
							run: {
								id: persisted.id,
								metadata: { completionGeneration: 1 },
							},
						},
					},
				],
			},
		} as unknown as ExtensionContext;

		reconcileBackgroundCompletions(ctx, runtime);

		assert.equal(
			typeof runtime.get(persisted.id)?.metadata?.completionDeliveredAt,
			"number",
		);
		assert.equal(
			runtime.get(persisted.id)?.metadata?.completionEnqueuedAt,
			undefined,
		);
		assert.equal(
			runtime.get(lost.id)?.metadata?.completionDeliveredAt,
			undefined,
		);
		assert.equal(
			runtime.get(lost.id)?.metadata?.completionEnqueuedAt,
			undefined,
		);

		const previous = runtime.get(persisted.id);
		assert.ok(previous);
		runtime.patchManagedRun(persisted.id, {
			metadata: {
				...previous.metadata,
				completionGeneration: 2,
				completionEnqueuedAt: Date.now(),
				completionDeliveredAt: undefined,
			},
		});
		reconcileBackgroundCompletions(ctx, runtime);
		assert.equal(
			runtime.get(persisted.id)?.metadata?.completionDeliveredAt,
			undefined,
		);
		assert.equal(
			runtime.get(persisted.id)?.metadata?.completionEnqueuedAt,
			undefined,
		);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
