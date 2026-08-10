import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
	buildChildSystemPrompt,
	discoverAgents,
	resolveNamedSkillPaths,
} from "../src/agents.ts";
import { DEFAULT_CONFIG } from "../src/config.ts";
import {
	discoverWorkflows,
	loadWorkflowForExecution,
} from "../src/workflows.ts";

test("builtin agents and workflows are discoverable", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-discovery-"));
	try {
		const agents = discoverAgents({
			cwd,
			projectTrusted: false,
			scope: "user",
			config: DEFAULT_CONFIG,
		});
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["general", "planner", "reviewer", "scout", "worker"],
		);
		assert.equal(
			agents
				.find((agent) => agent.name === "general")
				?.tools?.includes("write"),
			true,
		);
		assert.equal(
			agents.find((agent) => agent.name === "worker")?.workspace,
			"shared",
		);
		assert.equal(
			agents.every((agent) => agent.maxTurns === 128),
			true,
		);
		assert.equal(
			agents.every((agent) => agent.timeoutMs === 60 * 60_000),
			true,
		);
		const workflows = await discoverWorkflows(cwd, false);
		assert.deepEqual(
			workflows.map((workflow) => workflow.definition.name),
			["implement-and-review", "parallel-review", "scout-plan"],
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("child prompts expose generous limits and require a final handoff", () => {
	const definition = discoverAgents({
		cwd: os.tmpdir(),
		projectTrusted: false,
		scope: "user",
		config: DEFAULT_CONFIG,
	}).find((agent) => agent.name === "scout");
	assert.ok(definition);
	const prompt = buildChildSystemPrompt(definition, {
		runName: "repository-scout",
		maxTurns: 128,
		timeoutMs: 60 * 60_000,
	});
	assert.match(prompt, /at most 128 assistant turns and 1 hour wall-clock/);
	assert.match(prompt, /reserve enough budget for a final response/);
	assert.match(prompt, /best evidence-based partial result/);
	assert.match(prompt, /run name is repository-scout/);
});

test("trusted project workflow discovery is inert until launch approval", async () => {
	const cwd = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-project-workflow-"),
	);
	const directory = path.join(cwd, ".pi", "workflows");
	const marker = path.join(cwd, "executed");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "safe.workflow.ts"),
		`import fs from "node:fs";\nfs.writeFileSync(${JSON.stringify(marker)}, "executed");\nexport default { name: "safe-preview", description: "Inert preview", async run() { return "ok"; } };\n`,
	);
	try {
		const workflows = await discoverWorkflows(cwd, true);
		const workflow = workflows.find(
			(candidate) => candidate.definition.name === "safe-preview",
		);
		assert.ok(workflow);
		assert.equal(workflow.loaded, false);
		assert.equal(fs.existsSync(marker), false);
		const executable = await loadWorkflowForExecution(workflow);
		assert.equal(executable.loaded, true);
		assert.equal(fs.readFileSync(marker, "utf8"), "executed");
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("named project skills resolve only in trusted discovery", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-skill-"));
	const skillName = "pi-subagents-test-review";
	const skillPath = path.join(cwd, ".pi", "skills", skillName, "SKILL.md");
	fs.mkdirSync(path.dirname(skillPath), { recursive: true });
	fs.writeFileSync(
		skillPath,
		`---\nname: ${skillName}\ndescription: Review code.\n---\n# Review\n`,
	);
	try {
		assert.deepEqual(resolveNamedSkillPaths([skillName], cwd, true), [
			skillPath,
		]);
		assert.throws(
			() => resolveNamedSkillPaths([skillName], cwd, false),
			/Unknown declared skill/,
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});

test("project agents require trust and override builtins", () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-project-"));
	const directory = path.join(cwd, ".pi", "agents");
	fs.mkdirSync(directory, { recursive: true });
	fs.writeFileSync(
		path.join(directory, "scout.md"),
		`---\nname: scout\ndescription: Project scout\ntools: read\n---\nProject prompt.\n`,
	);
	try {
		const untrusted = discoverAgents({
			cwd,
			projectTrusted: false,
			scope: "both",
			config: DEFAULT_CONFIG,
		});
		assert.notEqual(
			untrusted.find((agent) => agent.name === "scout")?.source,
			"project",
		);
		const trusted = discoverAgents({
			cwd,
			projectTrusted: true,
			scope: "both",
			config: DEFAULT_CONFIG,
		});
		assert.equal(
			trusted.find((agent) => agent.name === "scout")?.source,
			"project",
		);
		assert.equal(
			trusted.find((agent) => agent.name === "scout")?.systemPrompt,
			"Project prompt.",
		);
	} finally {
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
