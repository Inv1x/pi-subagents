import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { getRuntime } from "../src/runtime.ts";

function captureExtension() {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<
		string,
		{ handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }
	>();
	extension({
		on: () => {},
		registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
		registerCommand: (name: string, command: unknown) =>
			commands.set(
				name,
				command as typeof commands extends Map<string, infer T> ? T : never,
			),
	} as unknown as ExtensionAPI);
	return { tools, commands };
}

function headlessContext(
	cwd: string,
	notifications: string[],
): ExtensionContext {
	return {
		cwd,
		mode: "json",
		hasUI: false,
		scopedModels: [],
		model: undefined,
		modelRegistry: {
			find: () => undefined,
			getAvailable: () => [],
		} as never,
		sessionManager: {
			getSessionId: () => "security-session",
			buildContextEntries: () => [],
		} as never,
		ui: {
			notify: (message: string) => notifications.push(message),
			confirm: async () => {
				throw new Error("headless confirmation must not be attempted");
			},
		} as never,
		isProjectTrusted: () => true,
		isIdle: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as ExtensionContext;
}

test("headless launches fail closed for project agents and workflow overrides", async () => {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-security-"));
	const userDir = path.join(cwd, "user");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = userDir;
	const projectAgentDir = path.join(cwd, ".pi", "agents");
	const projectWorkflowDir = path.join(cwd, ".pi", "workflows");
	const userWorkflowDir = path.join(userDir, "workflows");
	fs.mkdirSync(projectAgentDir, { recursive: true });
	fs.mkdirSync(projectWorkflowDir, { recursive: true });
	fs.mkdirSync(userWorkflowDir, { recursive: true });
	fs.writeFileSync(
		path.join(projectAgentDir, "reviewer.md"),
		"---\nname: reviewer\ndescription: Project reviewer\ntools: read\n---\nProject-controlled reviewer prompt.\n",
	);
	fs.writeFileSync(
		path.join(cwd, ".pi", "pi-subagents.json"),
		JSON.stringify({
			confirmProjectAgents: true,
			confirmProjectWorkflows: false,
		}),
	);
	const marker = path.join(cwd, "workflow-executed");
	fs.writeFileSync(
		path.join(userWorkflowDir, "user-review.workflow.ts"),
		`import fs from "node:fs";\nexport default { name: "user-review", description: "User review", async run() { fs.writeFileSync(${JSON.stringify(marker)}, "yes"); return "ran"; } };\n`,
	);
	fs.writeFileSync(
		path.join(projectWorkflowDir, "project-review.workflow.ts"),
		`export default { name: "project-review", description: "Project review", async run() { return "ran"; } };\n`,
	);
	try {
		const { tools, commands } = captureExtension();
		const notifications: string[] = [];
		const ctx = headlessContext(cwd, notifications);
		const subagent = tools.get("subagent_run");
		const workflow = tools.get("workflow_run");
		const workflowControl = tools.get("workflow_control");
		assert.ok(subagent?.execute);
		assert.ok(workflow?.execute);
		assert.ok(workflowControl?.execute);
		const subagentProperties = (
			subagent.parameters as { properties?: Record<string, unknown> }
		).properties;
		assert.equal(subagentProperties?.confirmProjectAgent, undefined);

		for (const params of [
			{ agent: "reviewer", task: "review" },
			{ agent: "reviewer", task: "review", confirmProjectAgent: false },
		]) {
			await assert.rejects(
				subagent.execute(
					"agent-call",
					params as never,
					undefined,
					undefined,
					ctx,
				),
				/interactive confirmation/,
			);
		}
		for (const workflowName of [
			"parallel-review",
			"user-review",
			"project-review",
		]) {
			await assert.rejects(
				workflow.execute(
					`workflow-${workflowName}`,
					{ workflow: workflowName, input: "review" },
					undefined,
					undefined,
					ctx,
				),
				/interactive launch confirmation/,
			);
		}

		const runtime = getRuntime();
		const resumable = runtime.createWorkflowRecord("user-review", "review", {
			cwd,
			sessionId: "security-session",
			background: true,
		});
		runtime.updateManagedRun(resumable.id, "failed");
		runtime.store.writeWorkflow({
			version: 1,
			runId: resumable.id,
			workflow: "user-review",
			input: "review",
			definitionHash: "not-reached-before-confirmation",
			state: "failed",
			createdAt: resumable.createdAt,
			updatedAt: Date.now(),
			steps: {},
		});
		try {
			await assert.rejects(
				workflowControl.execute(
					"workflow-resume",
					{ action: "resume", runId: resumable.id },
					undefined,
					undefined,
					ctx,
				),
				/interactive confirmation/,
			);
		} finally {
			(runtime as unknown as { records: Map<string, unknown> }).records.delete(
				resumable.id,
			);
			fs.rmSync(runtime.store.runDir(resumable.id), {
				recursive: true,
				force: true,
			});
		}

		const command = commands.get("workflow-run");
		assert.ok(command);
		await command.handler("user-review review", ctx as ExtensionCommandContext);
		assert.match(notifications.at(-1) ?? "", /interactive launch confirmation/);
		assert.equal(fs.existsSync(marker), false);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		fs.rmSync(cwd, { recursive: true, force: true });
	}
});
