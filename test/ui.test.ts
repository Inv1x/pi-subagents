import assert from "node:assert/strict";
import test from "node:test";
import type {
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { formatCount } from "../src/format.ts";
import type { SubagentRuntime } from "../src/runtime.ts";
import type { RunRecord, RunUpdate } from "../src/types.ts";
import {
	closeFleet,
	installUiProjection,
	openFleet,
	renderControlResult,
	renderRunCall,
	renderRunResult,
} from "../src/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	inverse: (text: string) => `[inverse]${text}[/inverse]`,
	bold: (text: string) => text,
} as ExtensionContext["ui"]["theme"];

const fleetKeybindings = {
	getKeys: (binding: string) =>
		({
			"tui.select.up": ["up"],
			"tui.select.down": ["down"],
			"tui.select.cancel": ["escape"],
			"app.interrupt": ["ctrl+c"],
		})[binding] ?? [],
	matches: (data: string, binding: string) =>
		({
			"\u001b[A": "tui.select.up",
			"\u001b[B": "tui.select.down",
			"\u001b": "tui.select.cancel",
			"\u0003": "app.interrupt",
		})[data] === binding,
} as unknown as KeybindingsManager;

function run(patch: Partial<RunRecord> = {}): RunRecord {
	const now = Date.now();
	return {
		version: 1,
		id: "agent_1234567890",
		kind: "agent",
		state: "running",
		background: true,
		sessionId: "session-a",
		agent: "scout",
		model: "openai-codex/gpt-5.6-sol",
		thinking: "high",
		cwd: "/tmp/project",
		workspace: "shared",
		createdAt: now - 5000,
		startedAt: now - 4000,
		updatedAt: now,
		usage: {
			turns: 1,
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.09,
			contextTokens: 120,
		},
		...patch,
	};
}

test("launch and control renderers stay compact", () => {
	const call = renderRunCall(
		{
			agent: "scout",
			task: "A long task that should stay hidden",
			background: true,
		},
		theme,
	)
		.render(120)
		.join("\n");
	assert.match(call, /scout.*background/);
	assert.doesNotMatch(call, /long task/);

	const completed = run({
		state: "succeeded",
		endedAt: Date.now(),
		output: JSON.stringify(
			{
				runId: "child",
				state: "succeeded",
				output: "# Plan\n\nDo the focused work.\n\nThen validate it.",
			},
			null,
			2,
		),
	});
	const rendered = renderControlResult(
		{
			content: [{ type: "text", text: completed.output }],
			details: { runs: [completed] },
		},
		{ expanded: false },
		theme,
	)
		.render(120)
		.join("\n");
	assert.match(rendered, /scout.*succeeded/);
	assert.doesNotMatch(rendered, /# Plan|focused work|runId|Ctrl\+O/);
	assert.match(rendered, /gpt-5\.6-sol.*high effort/);
	assert.doesNotMatch(rendered, /contextTokens/);

	const expanded = renderControlResult(
		{
			content: [{ type: "text", text: completed.output }],
			details: { runs: [completed] },
		},
		{ expanded: true },
		theme,
	)
		.render(120)
		.join("\n");
	assert.doesNotMatch(expanded, /# Plan|focused work|runId|Ctrl\+O/);
});

test("failed run cards show the startup cause, executable, and recovery guidance", () => {
	const failed = run({
		state: "failed",
		error: {
			code: "failed",
			message:
				'Could not start SDK child with Node.js executable "/removed/node": spawn /removed/node ENOENT\nIf Node.js was upgraded or removed while Pi was running, restart Pi to use the current executable.',
			retryable: false,
		},
	});
	for (const expanded of [false, true]) {
		for (const component of [
			renderRunResult(
				{ content: [], details: { run: failed } },
				{ expanded },
				theme,
			),
			renderControlResult(
				{ content: [], details: { runs: [failed] } },
				{ expanded },
				theme,
			),
		]) {
			const rendered = component.render(100).join("\n");
			assert.match(rendered, /ENOENT/);
			assert.match(rendered, /\/removed\/node/);
			assert.match(rendered, /restart Pi/);
		}
	}
});

test("quiet renderers show safe actionable errors and empty lists without child bodies", () => {
	for (const message of [
		"Unknown child model 'missing/model'. Use an exact available provider/model identifier.",
		"Unknown base agent 'missing-agent'. Available: scout, reviewer.",
	]) {
		const rendered = renderRunResult(
			{
				content: [
					{ type: "text", text: `${message}\nSECRET CHILD RESPONSE BODY` },
				],
			},
			{ expanded: false },
			theme,
			{ isError: true },
		)
			.render(300)
			.join("\n")
			.trimEnd();
		assert.equal(rendered, message);
	}

	const unknownRun = renderControlResult(
		{
			content: [
				{
					type: "text",
					text: `Run not found: agent_missing\u001b]8;;https://example.test\u0007${"x".repeat(400)}`,
				},
			],
		},
		{ expanded: false },
		theme,
		{ isError: true },
	)
		.render(300)
		.join("\n")
		.trimEnd();
	assert.match(unknownRun, /^Run not found: agent_missing/);
	assert.doesNotMatch(unknownRun, /example\.test/);
	assert.ok(unknownRun.length <= 250);

	const empty = renderControlResult(
		{
			content: [{ type: "text", text: "No subagent runs." }],
			details: { runs: [] },
		},
		{ expanded: false },
		theme,
	)
		.render(120)
		.join("\n")
		.trimEnd();
	assert.equal(empty, "No subagent runs.");

	const hidden = renderRunResult(
		{
			content: [{ type: "text", text: "SECRET CHILD RESPONSE BODY" }],
		},
		{ expanded: true },
		theme,
	)
		.render(120)
		.map((line) => line.trimEnd());
	assert.deepEqual(hidden, ["Subagent status unavailable."]);
});

test("running tool rows update elapsed time on natural renders without forced ticks", (context) => {
	context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const active = run({
		createdAt: 0,
		startedAt: 0,
		updatedAt: 0,
	});
	let current = active;
	let resolutions = 0;
	const component = renderRunResult(
		{
			content: [{ type: "text", text: "running" }],
			details: { run: active },
		},
		{ expanded: false, isPartial: false },
		theme,
		{
			resolveRun: () => {
				resolutions++;
				return current;
			},
		},
	);
	const render = () => component.render(120).join("\n");
	assert.match(render(), /running · 1s/);
	const resolutionsAfterRender = resolutions;

	context.mock.timers.tick(1000);
	assert.equal(resolutions, resolutionsAfterRender);
	assert.match(render(), /running · 2s/);

	current = {
		...active,
		state: "succeeded",
		endedAt: Date.now(),
		updatedAt: Date.now(),
	};
	assert.match(render(), /succeeded · 2s/);

	context.mock.timers.tick(5000);
	assert.match(render(), /succeeded · 2s/);
});

test("count formatting handles singular and plural nouns", () => {
	assert.equal(formatCount(1, "agent"), "1 agent");
	assert.equal(formatCount(2, "agent"), "2 agents");
	assert.equal(formatCount(2, "person", "people"), "2 people");
});

test("active fleet uses one session-scoped footer status and no widget", () => {
	const active = run({ metadata: { completionPending: true } });
	const otherSession = run({
		id: "agent_other_session",
		sessionId: "session-b",
		agent: "other-project-agent",
		usage: { ...run().usage, cost: 10 },
	});
	let listener: ((update: RunUpdate) => void) | undefined;
	const statuses: Array<string | undefined> = [];
	const widgets: unknown[] = [];
	const notifications: string[] = [];
	const runtime = {
		listForSession: (sessionId: string) =>
			[active, otherSession].filter((record) => record.sessionId === sessionId),
		getConfig: () => ({ showStatus: true }),
		markCompletionDelivered: () => {
			active.metadata = {
				...active.metadata,
				completionDeliveredAt: Date.now(),
			};
			return active;
		},
		subscribe: (next: (update: RunUpdate) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as SubagentRuntime;
	const ctx = {
		mode: "json",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			setStatus: (_id: string, value: string | undefined) =>
				statuses.push(value),
			setWidget: (_id: string, value: unknown) => widgets.push(value),
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;

	const observedRuns = new Set([active.id]);
	const completions: string[] = [];
	const uninstall = installUiProjection(
		ctx,
		runtime,
		observedRuns,
		(completed) => completions.push(completed.id),
	);
	assert.equal(statuses[0], "1 agent running · $0.09 · /subagents-fleet");
	assert.doesNotMatch(statuses[0] ?? "", /other-project-agent|10\.09/);
	assert.equal(widgets[0], undefined);

	active.state = "succeeded";
	active.endedAt = Date.now();
	listener?.({ run: { ...active }, previousState: "running" });
	assert.equal(statuses.at(-1), "1 agent finished · $0.09 · /subagents-fleet");
	assert.deepEqual(
		notifications,
		[],
		"completion toast is redundant while a wait call is rendering the result",
	);
	assert.deepEqual(
		completions,
		[],
		"completion message is redundant while a wait call returns the result",
	);
	uninstall();
});

test("every backgrounded top-level run emits one parent completion", () => {
	const agent = run({
		id: "agent_background",
		metadata: { completionPending: true },
	});
	const workflow = run({
		id: "workflow_background",
		kind: "workflow",
		agent: undefined,
		workflow: "parallel-review",
		metadata: { completionPending: true },
	});
	const foreground = run({ id: "agent_foreground", background: false });
	const child = run({
		id: "agent_workflow_child",
		background: false,
		parentRunId: workflow.id,
	});
	const records = [agent, workflow, foreground, child];
	let listener: ((update: RunUpdate) => void) | undefined;
	const notifications: string[] = [];
	const completions: string[] = [];
	const runtime = {
		listForSession: () => records,
		getConfig: () => ({ showStatus: true }),
		markCompletionDelivered: (id: string) => {
			const completed = records.find((record) => record.id === id);
			assert.ok(completed);
			completed.metadata = {
				...completed.metadata,
				completionDeliveredAt: Date.now(),
			};
			return completed;
		},
		markCompletionEnqueued: (id: string) => {
			const completed = records.find((record) => record.id === id);
			assert.ok(completed);
			completed.metadata = {
				...completed.metadata,
				completionEnqueuedAt: Date.now(),
			};
			return completed;
		},
		subscribe: (next: (update: RunUpdate) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as SubagentRuntime;
	const ctx = {
		mode: "json",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			setStatus: () => {},
			setWidget: () => {},
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext;

	const uninstall = installUiProjection(ctx, runtime, new Set(), (completed) =>
		completions.push(completed.id),
	);
	for (const completed of records) {
		completed.state = "succeeded";
		completed.endedAt = Date.now();
		listener?.({ run: { ...completed }, previousState: "running" });
	}
	listener?.({ run: { ...agent }, previousState: "running" });

	assert.deepEqual(completions, [agent.id, workflow.id]);
	assert.deepEqual(notifications, [
		"scout succeeded",
		"parallel-review succeeded",
	]);
	uninstall();
});

test("an inactive owner session queues on return and retries a lost queue", () => {
	const completed = run({
		id: "agent_inactive_session",
		state: "succeeded",
		endedAt: Date.now(),
		metadata: { completionPending: true },
	});
	let listener: ((update: RunUpdate) => void) | undefined;
	const runtime = {
		listForSession: (sessionId: string) =>
			completed.sessionId === sessionId ? [completed] : [],
		getConfig: () => ({ showStatus: true }),
		markCompletionDelivered: () => {
			completed.metadata = {
				...completed.metadata,
				completionEnqueuedAt: undefined,
				completionDeliveredAt: Date.now(),
			};
			return completed;
		},
		markCompletionEnqueued: () => {
			completed.metadata = {
				...completed.metadata,
				completionEnqueuedAt: Date.now(),
			};
			return completed;
		},
		subscribe: (next: (update: RunUpdate) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as SubagentRuntime;
	const context = (sessionId: string) =>
		({
			mode: "json",
			sessionManager: { getSessionId: () => sessionId },
			ui: {
				theme,
				setStatus: () => {},
				setWidget: () => {},
				notify: () => {},
			},
		}) as unknown as ExtensionContext;
	const completions: string[] = [];
	const receive = (record: RunRecord) => completions.push(record.id);

	const leaveInactive = installUiProjection(
		context("session-b"),
		runtime,
		new Set(),
		receive,
	);
	listener?.({ run: { ...completed }, previousState: "running" });
	assert.deepEqual(completions, []);
	assert.equal(completed.metadata?.completionDeliveredAt, undefined);
	leaveInactive();

	const returnToOwner = installUiProjection(
		context("session-a"),
		runtime,
		new Set(),
		receive,
	);
	assert.deepEqual(completions, [completed.id]);
	assert.equal(typeof completed.metadata?.completionEnqueuedAt, "number");
	assert.equal(completed.metadata?.completionDeliveredAt, undefined);

	completed.metadata = {
		...completed.metadata,
		completionEnqueuedAt: undefined,
	};
	listener?.({ run: { ...completed }, previousState: "succeeded" });
	assert.deepEqual(completions, [completed.id, completed.id]);
	assert.equal(typeof completed.metadata?.completionEnqueuedAt, "number");
	returnToOwner();

	const reinstall = installUiProjection(
		context("session-a"),
		runtime,
		new Set(),
		receive,
	);
	assert.deepEqual(completions, [completed.id, completed.id]);
	reinstall();
});

test("workflow children are grouped under workflow status, not agent counts", () => {
	const workflow = run({
		id: "workflow_status",
		kind: "workflow",
		workflow: "parallel-review",
		agent: undefined,
		usage: { ...run().usage, cost: 0.09 },
	});
	const child = run({
		id: "agent_workflow_child",
		parentRunId: workflow.id,
		stepId: "review.0",
		background: false,
	});
	const standalone = run({
		id: "agent_standalone",
		agent: "outside-worker",
		usage: { ...run().usage, cost: 0.03 },
	});
	const records = [workflow, child, standalone];
	let listener: ((update: RunUpdate) => void) | undefined;
	const statuses: Array<string | undefined> = [];
	const runtime = {
		listForSession: () => records,
		getConfig: () => ({ showStatus: true }),
		subscribe: (next: (update: RunUpdate) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
	} as unknown as SubagentRuntime;
	const ctx = {
		mode: "json",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			setStatus: (_id: string, value: string | undefined) =>
				statuses.push(value),
			setWidget: () => {},
			notify: () => {},
		},
	} as unknown as ExtensionContext;

	const uninstall = installUiProjection(ctx, runtime);
	assert.equal(
		statuses.at(-1),
		"1 agent running · 1 workflow running · $0.12 · /subagents-fleet",
	);
	assert.doesNotMatch(statuses.at(-1) ?? "", /2 agents/);

	const old = Date.now() - 10 * 60_000;
	workflow.state = "succeeded";
	workflow.updatedAt = old;
	workflow.endedAt = old;
	standalone.state = "succeeded";
	standalone.updatedAt = old;
	standalone.endedAt = old;
	child.state = "succeeded";
	child.updatedAt = Date.now();
	child.endedAt = child.updatedAt;
	listener?.({ run: { ...child }, previousState: "running" });
	assert.equal(
		statuses.at(-1),
		"1 workflow finished · $0.12 · /subagents-fleet",
	);

	child.endedAt = old;
	child.updatedAt = Date.now();
	listener?.({ run: { ...child }, previousState: "succeeded" });
	assert.equal(
		statuses.at(-1),
		undefined,
		"post-completion metadata updates must not extend the five-minute window",
	);
	uninstall();
});

test("fleet keeps every workflow child for the workflow-wide recent window", async () => {
	const old = Date.now() - 10 * 60_000;
	const workflow = run({
		id: "workflow_recent_family",
		kind: "workflow",
		workflow: "parallel-review",
		agent: undefined,
		state: "succeeded",
		updatedAt: old,
		endedAt: old,
	});
	const first = run({
		id: "agent_old_workflow_child",
		parentRunId: workflow.id,
		stepId: "reviews.0",
		state: "succeeded",
		updatedAt: old,
		endedAt: old,
	});
	const last = run({
		id: "agent_recent_workflow_child",
		parentRunId: workflow.id,
		stepId: "reviews.1",
		state: "succeeded",
		updatedAt: Date.now() - 60_000,
		endedAt: Date.now() - 60_000,
	});
	const records = [last, workflow, first];
	const runtime = {
		listForSession: () => records,
	} as unknown as SubagentRuntime;
	let component: Component | undefined;
	const tui = {
		terminal: { rows: 30 },
		requestRender: () => {},
	} as unknown as TUI;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			custom: async (
				factory: (
					tui: TUI,
					theme: ExtensionContext["ui"]["theme"],
					keys: KeybindingsManager,
					done: () => void,
				) => Component,
			) => {
				component = factory(tui, theme, fleetKeybindings, () => {});
				return undefined;
			},
		},
	} as unknown as ExtensionContext;

	await openFleet(ctx, runtime);
	const render = () => component?.render(120).join("\n") ?? "";
	assert.match(render(), /parallel-review/);
	assert.match(render(), /reviews\.0/);
	assert.match(render(), /reviews\.1/);

	last.updatedAt = old;
	last.endedAt = old;
	component?.handleInput?.("r");
	assert.match(render(), /No recorded runs/);
	assert.doesNotMatch(render(), /reviews\.0|reviews\.1/);
	(
		component as (Component & { dispose?: () => void }) | undefined
	)?.dispose?.();
});

test("fleet overlay takes initial focus without stealing it back", async () => {
	const active = run({ background: false });
	let terminalInput:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	let mount: ((handle: OverlayHandle) => void) | undefined;
	let overlaySettings:
		| { overlay?: boolean; overlayOptions?: { anchor?: string } }
		| undefined;
	let closeOverlay: (() => void) | undefined;
	let focused = false;
	let focusCalls = 0;
	const overlayClosed = new Promise<undefined>((resolve) => {
		closeOverlay = () => resolve(undefined);
	});
	const handle = {
		hide: () => {},
		setHidden: () => {},
		isHidden: () => false,
		getBounds: () => undefined,
		focus: () => {
			focused = true;
			focusCalls++;
		},
		unfocus: () => {
			focused = false;
		},
		isFocused: () => focused,
	} satisfies OverlayHandle;
	const runtime = {
		listForSession: (sessionId: string) =>
			active.sessionId === sessionId ? [active] : [],
		getConfig: () => ({ showStatus: true }),
		subscribe: () => () => {},
	} as unknown as SubagentRuntime;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			setStatus: () => {},
			setWidget: () => {},
			notify: () => {},
			getEditorText: () => "",
			onTerminalInput: (
				handler: (data: string) => { consume?: boolean } | undefined,
			) => {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
			custom: (
				_factory: unknown,
				options: {
					overlay?: boolean;
					overlayOptions?: { anchor?: string };
					onHandle?: (overlayHandle: OverlayHandle) => void;
				},
			) => {
				overlaySettings = options;
				mount = options.onHandle;
				return overlayClosed;
			},
		},
	} as unknown as ExtensionContext;

	const uninstall = installUiProjection(ctx, runtime);
	const fleet = openFleet(ctx, runtime);
	assert.equal(terminalInput?.("\u001b[B"), undefined);

	mount?.(handle);
	assert.equal(focusCalls, 1);
	assert.equal(overlaySettings?.overlay, true);
	assert.equal(overlaySettings?.overlayOptions?.anchor, "center");
	focused = false;
	assert.equal(terminalInput?.("\u001b[B"), undefined);
	assert.equal(focusCalls, 1, "newer overlays may retain focus");

	closeOverlay?.();
	await fleet;
	assert.equal(terminalInput?.("\u001b[B"), undefined);
	uninstall();
});

test("fleet lifecycle close disposes the overlay and allows reopening", async () => {
	const active = run();
	const runtime = {
		listForSession: () => [active],
	} as unknown as SubagentRuntime;
	const tui = {
		terminal: { rows: 30 },
		requestRender: () => {},
	} as unknown as TUI;
	let mounts = 0;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			custom: (
				factory: (
					tui: TUI,
					theme: ExtensionContext["ui"]["theme"],
					keys: unknown,
					done: () => void,
				) => Component,
			) =>
				new Promise<undefined>((resolve) => {
					let component: (Component & { dispose?: () => void }) | undefined;
					const done = () => {
						component?.dispose?.();
						resolve(undefined);
					};
					component = factory(tui, theme, fleetKeybindings, done);
					mounts++;
				}),
		},
	} as unknown as ExtensionContext;

	const first = openFleet(ctx, runtime);
	closeFleet(runtime, "session-a");
	await first;
	assert.equal(mounts, 1);

	const second = openFleet(ctx, runtime);
	closeFleet(runtime, "session-a");
	await second;
	assert.equal(mounts, 2);
});

test("fleet arrows select agents while j/k exclusively scroll output", async () => {
	const alpha = run({
		id: "agent_alpha",
		agent: "alpha",
		output: Array.from(
			{ length: 30 },
			(_, index) => `alpha line ${index}`,
		).join("\n"),
	});
	const beta = run({
		id: "agent_beta",
		agent: "beta",
		task: "Inspect the beta subsystem",
		difficulty: 5,
		outputArtifact: "/runs/beta/output.md",
		transcriptArtifact: "/runs/beta/transcript.log",
		patchArtifact: "/runs/beta/changes.patch",
		output: Array.from({ length: 30 }, (_, index) => `beta line ${index}`).join(
			"\n",
		),
	});
	const runtime = {
		listForSession: () => [alpha, beta],
		background: (id: string) => (id === alpha.id ? alpha : beta),
	} as unknown as SubagentRuntime;
	let component: Component | undefined;
	const tui = {
		terminal: { rows: 30 },
		requestRender: () => {},
	} as unknown as TUI;
	const conflictingKeybindings = {
		getKeys: (binding: Parameters<KeybindingsManager["getKeys"]>[0]) =>
			fleetKeybindings.getKeys(binding),
		matches: (
			data: string,
			binding: Parameters<KeybindingsManager["matches"]>[1],
		) =>
			(data === "\u001b[106u" && binding === "tui.select.down") ||
			fleetKeybindings.matches(data, binding),
	} as unknown as KeybindingsManager;
	const handle = {
		hide: () => {},
		setHidden: () => {},
		isHidden: () => false,
		getBounds: () => undefined,
		focus: () => {},
		unfocus: () => {},
		isFocused: () => true,
	} satisfies OverlayHandle;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			custom: async (
				factory: (
					tui: TUI,
					theme: ExtensionContext["ui"]["theme"],
					keys: unknown,
					done: () => void,
				) => Component,
				options: { onHandle?: (overlayHandle: OverlayHandle) => void },
			) => {
				component = factory(tui, theme, conflictingKeybindings, () => {});
				options.onHandle?.(handle);
				return undefined;
			},
		},
	} as unknown as ExtensionContext;

	await openFleet(ctx, runtime);
	const render = () => component?.render(120).join("\n") ?? "";
	assert.match(render(), /alpha · agent/);
	assert.match(
		render(),
		/Up\/Down select · g\/G first\/last · j\/k scroll output/,
	);
	assert.match(render(), /Esc\/Ctrl\+C\/q close/);
	assert.doesNotMatch(render(), /PgUp|PgDn|\besc\b|\bescape\b/);

	component?.handleInput?.("\u001b[106u");
	assert.match(render(), /alpha · agent/);
	assert.doesNotMatch(render(), /Run\s+agent_alpha/);
	component?.handleInput?.("\u001b[107u");
	assert.match(render(), /Run\s+agent_alpha/);

	component?.handleInput?.("\u001b[B");
	assert.match(render(), /beta · agent/);
	assert.match(render(), /Output\s+\/runs\/beta\/output\.md/);
	assert.match(render(), /Transcript\s*\/runs\/beta\/transcript\.log/);
	assert.match(render(), /Patch\s+\/runs\/beta\/changes\.patch/);
	assert.match(render(), /Inspect the beta subsystem/);
	assert.doesNotMatch(render(), /Difficulty/);
	component?.handleInput?.("j");
	assert.doesNotMatch(render(), /Run\s+agent_beta/);
	assert.match(render(), /Kind\s+agent/);
	component?.handleInput?.("k");
	assert.match(render(), /Run\s+agent_beta/);
	component?.handleInput?.("\u001b[6~");
	assert.match(render(), /Run\s+agent_beta/);
	component?.handleInput?.("\u001b[5~");
	assert.match(render(), /Run\s+agent_beta/);

	component?.handleInput?.("j");
	component?.handleInput?.("\u001b[A");
	assert.match(render(), /alpha · agent/);
	assert.match(render(), /Run\s+agent_alpha/);
	(
		component as (Component & { dispose?: () => void }) | undefined
	)?.dispose?.();
});

test("footer does not intercept navigation while Ctrl+B backgrounds a run", () => {
	const active = run({ background: false });
	let listener: ((update: RunUpdate) => void) | undefined;
	let terminalInput:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	const statuses: Array<string | undefined> = [];
	const runtime = {
		listForSession: (sessionId: string) =>
			active.sessionId === sessionId ? [active] : [],
		getConfig: () => ({ showStatus: true }),
		subscribe: (next: (update: RunUpdate) => void) => {
			listener = next;
			return () => {
				listener = undefined;
			};
		},
		background: () => {
			active.background = true;
			return active;
		},
	} as unknown as SubagentRuntime;
	const ctx = {
		mode: "tui",
		sessionManager: { getSessionId: () => "session-a" },
		ui: {
			theme,
			setStatus: (_id: string, value: string | undefined) =>
				statuses.push(value),
			setWidget: () => {},
			notify: () => {},
			getEditorText: () => "",
			onTerminalInput: (
				handler: (data: string) => { consume?: boolean } | undefined,
			) => {
				terminalInput = handler;
				return () => {
					terminalInput = undefined;
				};
			},
		},
	} as unknown as ExtensionContext;

	const uninstall = installUiProjection(ctx, runtime);
	assert.equal(terminalInput?.("\r"), undefined);
	assert.equal(terminalInput?.("\u001b[B"), undefined);
	assert.equal(terminalInput?.("\u001b[A"), undefined);
	assert.doesNotMatch(statuses.at(-1) ?? "", /\[inverse\]|›/);

	assert.deepEqual(terminalInput?.("\u0002"), { consume: true });
	assert.equal(active.background, true);
	assert.equal(terminalInput?.("\u001b[B"), undefined);
	assert.equal(terminalInput?.("\r"), undefined);
	uninstall();
	assert.equal(listener, undefined);
	assert.equal(terminalInput, undefined);
});
