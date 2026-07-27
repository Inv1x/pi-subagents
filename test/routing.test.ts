import assert from "node:assert/strict";
import test from "node:test";
import {
	resolveAgentModelRoute,
	resolveDifficulty,
	selectAgentModelProfile,
} from "../src/routing.ts";
import type { AgentModelProfile } from "../src/types.ts";

const profiles: AgentModelProfile[] = [
	{
		model: "provider/strong",
		thinking: "high",
		maxDifficulty: 5,
	},
	{
		model: "provider/light",
		thinking: "low",
		maxDifficulty: 2,
	},
];

test("difficulty defaults to 3 and rejects invalid programmatic values", () => {
	assert.equal(resolveDifficulty(undefined), 3);
	for (const value of [0, 6, 2.5, "3", null]) {
		assert.throws(() => resolveDifficulty(value), /integer from 1 to 5/);
	}
});

test("profiles select the smallest covering threshold with strongest fallback", () => {
	assert.equal(selectAgentModelProfile(profiles, 1)?.model, "provider/light");
	assert.equal(selectAgentModelProfile(profiles, 2)?.model, "provider/light");
	assert.equal(selectAgentModelProfile(profiles, 3)?.model, "provider/strong");
	assert.equal(selectAgentModelProfile(profiles, 5)?.model, "provider/strong");
	const lightProfile = profiles[1];
	assert.ok(lightProfile);
	assert.equal(
		selectAgentModelProfile([lightProfile], 5)?.model,
		"provider/light",
	);
	assert.equal(selectAgentModelProfile([], 3), undefined);
});

test("explicit fields override a selected profile independently", () => {
	assert.deepEqual(
		resolveAgentModelRoute({
			difficulty: 4,
			profiles,
			model: "provider/explicit",
			definitionModel: "provider/definition",
			definitionThinking: "medium",
			parentModel: "provider/parent",
			parentThinking: "minimal",
		}),
		{
			difficulty: 4,
			model: "provider/explicit",
			thinking: "high",
			profile: profiles[0],
		},
	);
	assert.equal(
		resolveAgentModelRoute({
			difficulty: 1,
			profiles,
			thinking: "max",
		}).thinking,
		"max",
	);
});

test("runtime routing rejects blank models and invalid workflow effort", () => {
	assert.throws(
		() => resolveAgentModelRoute({ model: "  " }),
		/model override cannot be blank/,
	);
	assert.throws(
		() =>
			resolveAgentModelRoute({
				thinking: "loud" as never,
			}),
		/Invalid child thinking effort/,
	);
});

test("empty profiles preserve definition then parent fallback", () => {
	assert.deepEqual(
		resolveAgentModelRoute({
			definitionModel: "provider/definition",
			parentModel: "provider/parent",
			parentThinking: "medium",
		}),
		{
			difficulty: 3,
			model: "provider/definition",
			thinking: "medium",
			profile: undefined,
		},
	);
});
