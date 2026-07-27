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
	assert.match(rendered, /# Plan/);
	assert.doesNotMatch(rendered, /runId/);
	assert.match(rendered, /gpt-5\.6-sol.*high effort/);
	assert.doesNotMatch(rendered, /contextTokens/);
});

test("running tool rows tick elapsed time and freeze when the run finishes", (context) => {
	context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const active = run({
		createdAt: 0,
		startedAt: 0,
		updatedAt: 0,
	});
	let current = active;
	let invalidations = 0;
	const result = {
		content: [{ type: "text", text: "running" }],
		details: { run: active },
	};
	const options = { expanded: false, isPartial: false };
	let component: Component;
	const invalidate = () => {
		invalidations++;
		component = renderRunResult(result, options, theme, {
			lastComponent: component,
			invalidate,
			resolveRun: () => current,
		});
	};
	component = renderRunResult(result, options, theme, {
		invalidate,
		resolveRun: () => current,
	});
	const render = () => component.render(120).join("\n");
	assert.match(render(), /running · 1s/);

	context.mock.timers.tick(1000);
	assert.equal(invalidations, 1);
	assert.match(render(), /running · 2s/);

	current = {
		...active,
		state: "succeeded",
		endedAt: Date.now(),
		updatedAt: Date.now(),
	};
	context.mock.timers.tick(1000);
	assert.equal(invalidations, 2);
	assert.match(render(), /succeeded · 2s/);

	context.mock.timers.tick(5000);
	assert.equal(invalidations, 2);
	assert.match(render(), /succeeded · 2s/);
});

test("detached running tool rows stop their shared elapsed ticker", (context) => {
	context.mock.timers.enable({ apis: ["Date", "setInterval"], now: 1000 });
	const active = run({ createdAt: 0, startedAt: 0, updatedAt: 0 });
	let invalidations = 0;
	const component = renderRunResult(
		{
			content: [{ type: "text", text: "running" }],
			details: { run: active },
		},
		{ expanded: false, isPartial: false },
		theme,
		{
			invalidate: () => {
				invalidations++;
			},
			resolveRun: () => active,
		},
	);
	component.render(120);

	context.mock.timers.tick(1000);
	context.mock.timers.tick(1000);
	assert.equal(invalidations, 2);
	context.mock.timers.tick(1000);
	context.mock.timers.tick(5000);
	assert.equal(invalidations, 2);
});

test("count formatting handles singular and plural nouns", () => {
	assert.equal(formatCount(1, "agent"), "1 agent");
	assert.equal(formatCount(2, "agent"), "2 agents");
	assert.equal(formatCount(2, "person", "people"), "2 people");
});

test("active fleet uses one session-scoped footer status and no widget", () => {
	const active = run();
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
	const uninstall = installUiProjection(ctx, runtime, observedRuns);
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
	uninstall();
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
	const handle = {
		hide: () => {},
		setHidden: () => {},
		isHidden: () => false,
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
				component = factory(tui, theme, fleetKeybindings, () => {});
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

	component?.handleInput?.("\u001b[B");
	assert.match(render(), /beta · agent/);
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
