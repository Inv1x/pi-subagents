import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	mergeAgentModels,
	normalizeAgentModels,
	readAgentModelsFile,
	resolveShowStatus,
	writeAgentModelsFile,
} from "../src/config.ts";

test("agent model config normalizes profiles and thresholds", () => {
	assert.deepEqual(
		normalizeAgentModels({
			general: [
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
				{
					model: "invalid-bare-model",
					thinking: "loud",
					maxDifficulty: 3,
				},
			],
			"invalid name": [],
		}),
		{
			general: [
				{
					model: "provider/light",
					thinking: "low",
					maxDifficulty: 2,
				},
				{
					model: "provider/strong",
					thinking: "high",
					maxDifficulty: 5,
				},
			],
		},
	);
});

test("project arrays replace only matching user agent profiles", () => {
	const user = {
		general: [{ model: "user/general", thinking: "low", maxDifficulty: 5 }],
		scout: [{ model: "user/scout", thinking: "medium", maxDifficulty: 5 }],
	};
	const project = { general: [] };
	assert.deepEqual(mergeAgentModels(user, project), {
		general: [],
		scout: [{ model: "user/scout", thinking: "medium", maxDifficulty: 5 }],
	});
	assert.deepEqual(
		mergeAgentModels(user, {
			general: [{ model: "typo", thinking: "loud", maxDifficulty: 9 }],
		}),
		user,
	);
});

test("canonical status settings respect user and project precedence", () => {
	assert.equal(
		resolveShowStatus({ showWidget: false }, { showStatus: true }),
		true,
	);
	assert.equal(
		resolveShowStatus({ showStatus: false }, { showWidget: true }),
		true,
	);
	assert.equal(
		resolveShowStatus({ showWidget: false, showStatus: true }, {}),
		true,
	);
});

test("profile writer preserves unrelated settings and other agents", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-config-"),
	);
	const filePath = path.join(directory, "pi-subagents.json");
	try {
		fs.writeFileSync(
			filePath,
			JSON.stringify({
				maxConcurrency: 7,
				unknownFutureSetting: true,
				agentModels: {
					futureAgent: [{ futureProfileShape: true }],
					scout: [
						{
							model: "provider/scout",
							thinking: "low",
							maxDifficulty: 5,
						},
					],
				},
			}),
		);
		writeAgentModelsFile(filePath, "general", [
			{
				model: "provider/general",
				thinking: "high",
				maxDifficulty: 5,
			},
		]);
		const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
		assert.equal(raw.maxConcurrency, 7);
		assert.equal(raw.unknownFutureSetting, true);
		assert.deepEqual(raw.agentModels.futureAgent, [
			{ futureProfileShape: true },
		]);
		assert.deepEqual(Object.keys(readAgentModelsFile(filePath)).sort(), [
			"general",
			"scout",
		]);
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});

test("profile writer refuses to replace malformed configuration", () => {
	const directory = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-config-invalid-"),
	);
	const filePath = path.join(directory, "pi-subagents.json");
	try {
		fs.writeFileSync(filePath, "{ malformed");
		assert.throws(
			() =>
				writeAgentModelsFile(filePath, "general", [
					{
						model: "provider/general",
						thinking: "high",
						maxDifficulty: 5,
					},
				]),
			/Cannot update/,
		);
		assert.equal(fs.readFileSync(filePath, "utf8"), "{ malformed");
	} finally {
		fs.rmSync(directory, { recursive: true, force: true });
	}
});
