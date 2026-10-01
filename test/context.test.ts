import assert from "node:assert/strict";
import test from "node:test";
import {
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
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

test("model routing uses every available model and ignores scopes", () => {
	const changedContext = routingContext({
		current: { provider: "current", id: "outside" },
		scoped: [{ provider: "current", id: "outside" }],
	});
	assert.equal(
		canonicalModelSpec(changedContext, "old/model", ["different/model"]),
		"old/model",
		"old persisted workflow scopes are readable but ignored",
	);
	assert.equal(
		canonicalModelSpec(changedContext, "model", ["different/model"]),
		"old/model",
		"bare model names resolve against all available models",
	);
	assert.equal(
		canonicalModelSpec(changedContext, undefined, ["old/model"]),
		undefined,
	);
	assert.equal(
		canonicalModelSpec(changedContext, "current/outside", ["old/model"]),
		"current/outside",
	);
});

test("summary uses canonical restored projection and honors context edits and compaction", () => {
	const manager = SessionManager.inMemory();
	const old = manager.appendMessage({
		role: "user",
		content: "forgotten history",
		timestamp: 1,
	});
	manager.appendCompaction("Earlier decisions and files.", null, 100);
	const omitted = manager.appendMessage({
		role: "user",
		content: "abandoned failed attempt",
		timestamp: 2,
	});
	const replaced = manager.appendMessage({
		role: "user",
		content: "original secret",
		timestamp: 3,
	});
	manager.appendContextEdit(omitted, null);
	manager.appendContextEdit(replaced, { content: "Retained replacement." });
	const restored = SessionManager.inMemory(
		process.cwd(),
		{ id: manager.getSessionId() },
		manager.getEntries(),
	);
	const ctx = { sessionManager: restored } as unknown as ExtensionContext;
	const summary = parentSummary(ctx);
	assert.match(
		summary,
		/\[Compaction summary\]\nEarlier decisions and files\./,
	);
	assert.match(summary, /user: Retained replacement\./);
	assert.doesNotMatch(summary, /forgotten|abandoned|original secret/);
	assert.ok(restored.getEntry(old), "raw history remains intact");
	assert.equal(parentSummary(ctx, 0), "");
	assert.ok(parentSummary(ctx, 20).length <= 20);
	restored.branch(replaced);
	assert.match(
		parentSummary(ctx),
		/original secret/,
		"branching before edits restores original context",
	);
});
