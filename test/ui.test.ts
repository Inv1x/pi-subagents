import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
} from "../src/ui.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	inverse: (text: string) => `[inverse]${text}[/inverse]`,
	bold: (text: string) => text,
} as ExtensionContext["ui"]["theme"];

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

test("fleet overlay takes initial focus without stealing it back", async () => {
	const active = run({ background: false });
	let terminalInput:
		| ((data: string) => { consume?: boolean } | undefined)
		| undefined;
	let mount: ((handle: OverlayHandle) => void) | undefined;
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
				options: { onHandle?: (overlayHandle: OverlayHandle) => void },
			) => {
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
					component = factory(tui, theme, {}, done);
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
				component = factory(tui, theme, {}, () => {});
				options.onHandle?.(handle);
				return undefined;
			},
		},
	} as unknown as ExtensionContext;

	await openFleet(ctx, runtime);
	const render = () => component?.render(120).join("\n") ?? "";
	assert.match(render(), /alpha · agent/);
	assert.match(render(), /↑↓ select · g\/G first\/last · j\/k scroll output/);
	assert.doesNotMatch(render(), /PgUp|PgDn/);

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
