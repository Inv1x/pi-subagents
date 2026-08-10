import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { canonicalModelSpec, parentSummary } from "../src/index.ts";

function routingContext(options: {
	current?: { provider: string; id: string };
	scoped?: Array<{ provider: string; id: string }>;
}): ExtensionContext {
	const models = [
		{ provider: "old", id: "model" },
		{ provider: "current", id: "outside" },
	];
	return {
		model: options.current,
		scopedModels: (options.scoped ?? []).map((model) => ({ model })),
		modelRegistry: {
			find: (provider: string, id: string) =>
				models.find((model) => model.provider === provider && model.id === id),
			getAvailable: () => models,
		},
	} as unknown as ExtensionContext;
}

test("pinned model routing preserves unrestricted snapshots and validates fallbacks", () => {
	const changedContext = routingContext({
		current: { provider: "current", id: "outside" },
		scoped: [{ provider: "current", id: "outside" }],
	});
	assert.equal(
		canonicalModelSpec(changedContext, "old/model", undefined),
		"old/model",
		"an undefined snapshot scope remains unrestricted after the current scope changes",
	);
	assert.equal(
		canonicalModelSpec(changedContext, "model", ["old/model"]),
		"old/model",
		"short fallback routes resolve only within the pinned scope",
	);
	assert.equal(
		canonicalModelSpec(changedContext, undefined, ["old/model"]),
		undefined,
		"an undefined saved model stays undefined instead of drifting to the current model",
	);
	assert.throws(
		() => canonicalModelSpec(changedContext, "current/outside", ["old/model"]),
		/outside the pinned scopedModels selection/,
	);
});

test("summary context uses compacted entries and retains summaries and messages", () => {
	let usedCompactionAwareEntries = false;
	const ctx = {
		sessionManager: {
			buildContextEntries: () => {
				usedCompactionAwareEntries = true;
				return [
					{ type: "compaction", summary: "Earlier decisions and files." },
					{
						type: "message",
						message: { role: "user", content: "Retained user request." },
					},
					{ type: "branch_summary", summary: "Abandoned branch findings." },
					{
						type: "message",
						message: {
							role: "assistant",
							content: [{ type: "text", text: "Retained assistant result." }],
						},
					},
				];
			},
			getBranch: () => {
				throw new Error("raw branch must not be used");
			},
		},
	} as unknown as ExtensionContext;
	const summary = parentSummary(ctx);
	assert.equal(usedCompactionAwareEntries, true);
	assert.match(
		summary,
		/\[Compaction summary\]\nEarlier decisions and files\./,
	);
	assert.match(summary, /user: Retained user request\./);
	assert.match(summary, /\[Branch summary\]\nAbandoned branch findings\./);
	assert.match(summary, /assistant: Retained assistant result\./);
});
