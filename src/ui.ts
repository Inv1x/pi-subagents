import type {
	ExtensionContext,
	KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	Markdown,
	matchesKey,
	type OverlayHandle,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { formatCount } from "./format.ts";
import type { SubagentRuntime } from "./runtime.ts";
import type {
	ControlToolDetails,
	RunRecord,
	RunUpdate,
	SubagentToolDetails,
} from "./types.ts";
import { TERMINAL_STATES } from "./types.ts";

function compactNumber(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000)
		return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}m`;
}

function duration(record: RunRecord): string {
	const start = record.startedAt ?? record.createdAt;
	const end = record.endedAt ?? Date.now();
	const seconds = Math.max(0, Math.floor((end - start) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

function glyph(state: RunRecord["state"]): string {
	switch (state) {
		case "succeeded":
			return "✓";
		case "failed":
		case "timed_out":
		case "orphaned":
			return "✗";
		case "cancelled":
		case "paused":
			return "■";
		case "queued":
			return "◦";
		default:
			return "●";
	}
}

function stateColor(
	state: RunRecord["state"],
): "success" | "error" | "warning" | "muted" | "accent" {
	if (state === "succeeded") return "success";
	if (state === "failed" || state === "timed_out" || state === "orphaned")
		return "error";
	if (state === "cancelled" || state === "paused") return "warning";
	if (state === "queued") return "muted";
	return "accent";
}

function usageLine(run: RunRecord): string {
	const pieces: string[] = [];
	if (run.usage.turns) pieces.push(`${run.usage.turns} turns`);
	if (run.usage.input) pieces.push(`↑${compactNumber(run.usage.input)}`);
	if (run.usage.output) pieces.push(`↓${compactNumber(run.usage.output)}`);
	if (run.usage.cacheRead)
		pieces.push(`R${compactNumber(run.usage.cacheRead)}`);
	if (run.usage.cacheWrite)
		pieces.push(`W${compactNumber(run.usage.cacheWrite)}`);
	if (run.usage.cost) pieces.push(`$${run.usage.cost.toFixed(4)}`);
	if (run.model) pieces.push(run.model);
	return pieces.join(" · ");
}

function runTitle(run: RunRecord): string {
	return run.agent ?? run.workflow ?? run.kind;
}

function modelLabel(model: string | undefined): string | undefined {
	return model?.split("/").at(-1);
}

function selectionParts(run: RunRecord): string[] {
	return [
		modelLabel(run.model),
		run.thinking ? `${run.thinking} effort` : undefined,
	].filter((part): part is string => Boolean(part));
}

function statusLine(
	run: RunRecord,
	theme: ExtensionContext["ui"]["theme"],
	includeTitle: boolean,
): string {
	const icon = theme.fg(stateColor(run.state), glyph(run.state));
	const title = includeTitle
		? `${theme.fg("toolTitle", theme.bold(runTitle(run)))} · `
		: "";
	const attempts =
		typeof run.metadata?.attempt === "number" && run.metadata.attempt > 1
			? `${run.metadata.attempt} attempts`
			: undefined;
	const details = [
		duration(run),
		attempts,
		...selectionParts(run),
		run.usage.cost ? `$${run.usage.cost.toFixed(4)}` : undefined,
	].filter((part): part is string => Boolean(part));
	return `${icon} ${title}${theme.fg("muted", run.state)} · ${theme.fg("dim", details.join(" · "))}`;
}

function visibleOutput(output: string): { text: string; structured: boolean } {
	const trimmed = output.trim();
	if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
		return { text: output, structured: false };
	try {
		const value = JSON.parse(trimmed) as { output?: unknown } | unknown[];
		if (!Array.isArray(value) && typeof value.output === "string")
			return { text: value.output, structured: true };
		return { text: "", structured: true };
	} catch {
		return { text: output, structured: false };
	}
}

function collapsedRun(
	run: RunRecord,
	theme: ExtensionContext["ui"]["theme"],
	includeTitle: boolean,
): Component {
	const lines = [statusLine(run, theme, includeTitle)];
	if (run.error) lines.push(theme.fg("error", run.error.message));
	else if (!TERMINAL_STATES.has(run.state) && run.activity?.message)
		lines.push(theme.fg("dim", run.activity.message));
	else if (run.output) {
		const output = visibleOutput(run.output);
		const outputLines = output.text.split("\n");
		if (output.text)
			lines.push(theme.fg("toolOutput", outputLines.slice(0, 3).join("\n")));
		if (output.structured && !output.text)
			lines.push(theme.fg("dim", "Structured result"));
		if (output.structured || outputLines.length > 3)
			lines.push(theme.fg("muted", "(Ctrl+O for details)"));
	}
	return new Text(lines.join("\n"), 0, 0);
}

function expandedRun(
	run: RunRecord,
	recentActivity: string[] | undefined,
	theme: ExtensionContext["ui"]["theme"],
): Component {
	const container = new Container();
	container.addChild(new Text(statusLine(run, theme, true), 0, 0));
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Task"), 0, 0));
	container.addChild(
		new Text(
			theme.fg("dim", run.task ?? JSON.stringify(run.metadata?.input ?? "")),
			0,
			0,
		),
	);
	if (recentActivity?.length) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("muted", "Recent activity"), 0, 0));
		container.addChild(
			new Text(
				recentActivity.map((line) => theme.fg("dim", `→ ${line}`)).join("\n"),
				0,
				0,
			),
		);
	}
	container.addChild(new Spacer(1));
	container.addChild(new Text(theme.fg("muted", "Result"), 0, 0));
	if (run.output)
		container.addChild(new Markdown(run.output, 0, 0, getMarkdownTheme()));
	else
		container.addChild(
			new Text(theme.fg("dim", run.error?.message ?? "(running)"), 0, 0),
		);
	const paths = [
		run.outputArtifact ? `Output: ${run.outputArtifact}` : undefined,
		run.transcriptArtifact
			? `Transcript: ${run.transcriptArtifact}`
			: undefined,
		run.patchArtifact ? `Patch: ${run.patchArtifact}` : undefined,
	].filter((line): line is string => Boolean(line));
	if (paths.length) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(paths.map((line) => theme.fg("dim", line)).join("\n"), 0, 0),
		);
	}
	const usage = usageLine(run);
	if (usage) container.addChild(new Text(theme.fg("dim", usage), 0, 0));
	return container;
}

export function renderRunCall(
	args: Record<string, unknown>,
	theme: ExtensionContext["ui"]["theme"],
): Component {
	const name =
		typeof args.agent === "string"
			? args.agent
			: typeof args.workflow === "string"
				? args.workflow
				: "subagent";
	const background =
		args.background === true ? theme.fg("muted", " · background") : "";
	return new Text(
		`${theme.fg("toolTitle", theme.bold(name))}${background}`,
		0,
		0,
	);
}

type RunRenderLifecycle = {
	lastComponent?: Component;
	invalidate?: () => void;
	resolveRun?: (runId: string) => RunRecord | undefined;
};

const LIVE_RUN_TICK_MS = 1000;
const LIVE_RUN_STALE_MS = 2500;

class LiveRunComponent implements Component {
	private run: RunRecord;
	private recentActivity: string[] | undefined;
	private expanded: boolean;
	private theme: ExtensionContext["ui"]["theme"];
	private invalidateRow: (() => void) | undefined;
	private resolveRun: ((runId: string) => RunRecord | undefined) | undefined;
	private lastRenderedAt = Date.now();

	constructor(
		run: RunRecord,
		recentActivity: string[] | undefined,
		expanded: boolean,
		theme: ExtensionContext["ui"]["theme"],
		lifecycle: RunRenderLifecycle,
	) {
		this.resolveRun = lifecycle.resolveRun;
		this.run = this.resolveRun?.(run.id) ?? run;
		this.recentActivity = recentActivity;
		this.expanded = expanded;
		this.theme = theme;
		this.invalidateRow = lifecycle.invalidate;
		this.syncTicker();
	}

	update(
		run: RunRecord,
		recentActivity: string[] | undefined,
		expanded: boolean,
		theme: ExtensionContext["ui"]["theme"],
		lifecycle: RunRenderLifecycle,
	): void {
		this.resolveRun = lifecycle.resolveRun;
		this.run = this.resolveRun?.(run.id) ?? run;
		this.recentActivity = recentActivity;
		this.expanded = expanded;
		this.theme = theme;
		this.invalidateRow = lifecycle.invalidate;
		this.syncTicker();
	}

	private syncTicker(): void {
		if (TERMINAL_STATES.has(this.run.state) || !this.invalidateRow)
			unregisterLiveRunComponent(this);
		else registerLiveRunComponent(this);
	}

	tick(now: number): void {
		if (now - this.lastRenderedAt > LIVE_RUN_STALE_MS) {
			unregisterLiveRunComponent(this);
			return;
		}
		const latest = this.resolveRun?.(this.run.id);
		if (latest) this.run = latest;
		this.invalidateRow?.();
		if (TERMINAL_STATES.has(this.run.state)) unregisterLiveRunComponent(this);
	}

	render(width: number): string[] {
		this.lastRenderedAt = Date.now();
		this.syncTicker();
		const component = this.expanded
			? expandedRun(this.run, this.recentActivity, this.theme)
			: collapsedRun(this.run, this.theme, false);
		return component.render(width);
	}

	invalidate(): void {}

	dispose(): void {
		unregisterLiveRunComponent(this);
	}
}

const liveRunRefs = new Set<WeakRef<LiveRunComponent>>();
const liveRunRegistrations = new WeakMap<
	LiveRunComponent,
	WeakRef<LiveRunComponent>
>();
let liveRunTicker: ReturnType<typeof setInterval> | undefined;

function registerLiveRunComponent(component: LiveRunComponent): void {
	if (liveRunRegistrations.has(component)) return;
	const reference = new WeakRef(component);
	liveRunRegistrations.set(component, reference);
	liveRunRefs.add(reference);
	if (liveRunTicker) return;
	liveRunTicker = setInterval(() => {
		const now = Date.now();
		for (const candidate of liveRunRefs) {
			const live = candidate.deref();
			if (live) live.tick(now);
			else liveRunRefs.delete(candidate);
		}
		if (!liveRunRefs.size) stopLiveRunTicker();
	}, LIVE_RUN_TICK_MS);
	liveRunTicker.unref?.();
}

function unregisterLiveRunComponent(component: LiveRunComponent): void {
	const reference = liveRunRegistrations.get(component);
	if (!reference) return;
	liveRunRegistrations.delete(component);
	liveRunRefs.delete(reference);
	if (!liveRunRefs.size) stopLiveRunTicker();
}

function stopLiveRunTicker(): void {
	if (!liveRunTicker) return;
	clearInterval(liveRunTicker);
	liveRunTicker = undefined;
}

export function renderRunResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	},
	options: { expanded: boolean; isPartial?: boolean },
	theme: ExtensionContext["ui"]["theme"],
	lifecycle: RunRenderLifecycle = {},
): Component {
	const details = result.details as SubagentToolDetails | undefined;
	const run = details?.run;
	if (!run) {
		if (lifecycle.lastComponent instanceof LiveRunComponent)
			lifecycle.lastComponent.dispose();
		return new Text(
			result.content.find((part) => part.type === "text")?.text ??
				"(no output)",
			0,
			0,
		);
	}
	const component =
		lifecycle.lastComponent instanceof LiveRunComponent
			? lifecycle.lastComponent
			: new LiveRunComponent(
					run,
					details.recentActivity,
					options.expanded,
					theme,
					lifecycle,
				);
	component.update(
		run,
		details.recentActivity,
		options.expanded,
		theme,
		lifecycle,
	);
	return component;
}

export function renderControlCall(
	kind: "subagent" | "workflow",
	args: Record<string, unknown>,
	theme: ExtensionContext["ui"]["theme"],
): Component {
	const action = typeof args.action === "string" ? args.action : "control";
	return new Text(
		`${theme.fg("toolTitle", theme.bold(kind))} ${theme.fg("muted", action)}`,
		0,
		0,
	);
}

export function renderControlResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: unknown;
	},
	options: { expanded: boolean; isPartial?: boolean },
	theme: ExtensionContext["ui"]["theme"],
): Component {
	const runs = (result.details as ControlToolDetails | undefined)?.runs;
	if (!runs?.length)
		return new Text(
			result.content.find((part) => part.type === "text")?.text ?? "(no runs)",
			0,
			0,
		);
	const firstRun = runs[0];
	if (runs.length === 1 && firstRun)
		return options.expanded
			? expandedRun(firstRun, undefined, theme)
			: collapsedRun(firstRun, theme, true);
	const shown = options.expanded ? runs : runs.slice(0, 8);
	const lines = shown.map((run) => statusLine(run, theme, true));
	if (shown.length < runs.length)
		lines.push(theme.fg("muted", `… +${runs.length - shown.length} more`));
	return new Text(lines.join("\n"), 0, 0);
}

const RECENT_RUN_WINDOW_MS = 5 * 60_000;
const ALL_SESSION_RUNS = Number.MAX_SAFE_INTEGER;

type FleetOverlayState = {
	handle?: OverlayHandle;
	close?: () => void;
};

const fleetOverlayStates = new WeakMap<
	SubagentRuntime,
	Map<string, FleetOverlayState>
>();

function getFleetOverlayState(
	runtime: SubagentRuntime,
	sessionId: string,
): FleetOverlayState | undefined {
	return fleetOverlayStates.get(runtime)?.get(sessionId);
}

function beginFleetOverlay(
	runtime: SubagentRuntime,
	sessionId: string,
): FleetOverlayState | undefined {
	const states = fleetOverlayStates.get(runtime) ?? new Map();
	fleetOverlayStates.set(runtime, states);
	if (states.has(sessionId)) return undefined;
	const state: FleetOverlayState = {};
	states.set(sessionId, state);
	return state;
}

function endFleetOverlay(
	runtime: SubagentRuntime,
	sessionId: string,
	state: FleetOverlayState,
): void {
	const states = fleetOverlayStates.get(runtime);
	if (states?.get(sessionId) !== state) return;
	states.delete(sessionId);
	if (!states.size) fleetOverlayStates.delete(runtime);
}

export function closeFleet(runtime: SubagentRuntime, sessionId: string): void {
	getFleetOverlayState(runtime, sessionId)?.close?.();
}

function workflowFamilyActivity(runs: RunRecord[]): Map<string, number> {
	const activity = new Map<string, number>();
	for (const run of runs) {
		if (run.kind === "workflow") activity.set(run.id, run.updatedAt);
	}
	for (const run of runs) {
		if (!run.parentRunId || !activity.has(run.parentRunId)) continue;
		activity.set(
			run.parentRunId,
			Math.max(activity.get(run.parentRunId) ?? 0, run.updatedAt),
		);
	}
	return activity;
}

function inspectableFleetRuns(
	runs: RunRecord[],
	now = Date.now(),
): RunRecord[] {
	const familyActivity = workflowFamilyActivity(runs);
	const inspectableWorkflows = new Set(
		runs
			.filter(
				(run) =>
					run.kind === "workflow" &&
					(!TERMINAL_STATES.has(run.state) ||
						(familyActivity.get(run.id) ?? run.updatedAt) >=
							now - RECENT_RUN_WINDOW_MS),
			)
			.map((run) => run.id),
	);
	return runs.filter((run) => {
		if (run.kind === "workflow") return inspectableWorkflows.has(run.id);
		if (run.parentRunId && familyActivity.has(run.parentRunId))
			return inspectableWorkflows.has(run.parentRunId);
		return (
			!TERMINAL_STATES.has(run.state) ||
			run.updatedAt >= now - RECENT_RUN_WINDOW_MS
		);
	});
}

export function installUiProjection(
	ctx: ExtensionContext,
	runtime: SubagentRuntime,
	observedRuns: ReadonlySet<string> = new Set(),
): () => void {
	const sessionId = ctx.sessionManager.getSessionId();
	const notified = new Set<string>();
	let expiryTimer: ReturnType<typeof setTimeout> | undefined;
	const sessionRuns = () => runtime.listForSession(sessionId, ALL_SESSION_RUNS);
	const activeStandaloneAgents = () =>
		runtime
			.listForSession(sessionId, 200)
			.filter(
				(run) =>
					run.kind === "agent" &&
					!run.parentRunId &&
					!run.background &&
					!TERMINAL_STATES.has(run.state),
			);
	const refresh = (update?: RunUpdate) => {
		if (update && update.run.sessionId !== sessionId) return;
		const now = Date.now();
		const all = sessionRuns();
		const familyActivity = workflowFamilyActivity(all);
		const inspectable = inspectableFleetRuns(all, now);
		const standaloneAgents = all.filter(
			(run) => run.kind === "agent" && !run.parentRunId,
		);
		const workflows = all.filter((run) => run.kind === "workflow");
		const activeAgents = standaloneAgents.filter(
			(run) => !TERMINAL_STATES.has(run.state),
		);
		const activeWorkflows = workflows.filter(
			(run) => !TERMINAL_STATES.has(run.state),
		);
		const recentFinishedAgents = standaloneAgents.filter(
			(run) =>
				TERMINAL_STATES.has(run.state) &&
				run.updatedAt >= now - RECENT_RUN_WINDOW_MS,
		);
		const recentFinishedWorkflows = workflows.filter(
			(run) =>
				TERMINAL_STATES.has(run.state) &&
				(familyActivity.get(run.id) ?? run.updatedAt) >=
					now - RECENT_RUN_WINDOW_MS,
		);
		const queuedAgents = activeAgents.filter(
			(run) => run.state === "queued",
		).length;
		const runningAgents = activeAgents.filter(
			(run) => run.state === "running" || run.state === "starting",
		).length;
		const runningWorkflows = activeWorkflows.filter(
			(run) => run.state === "running" || run.state === "starting",
		).length;
		const queuedWorkflows = activeWorkflows.filter(
			(run) => run.state === "queued",
		).length;
		if (expiryTimer) clearTimeout(expiryTimer);
		expiryTimer = undefined;
		const nextExpiry = [
			...recentFinishedAgents.map(
				(run) => run.updatedAt + RECENT_RUN_WINDOW_MS,
			),
			...recentFinishedWorkflows.map(
				(run) =>
					(familyActivity.get(run.id) ?? run.updatedAt) + RECENT_RUN_WINDOW_MS,
			),
		].reduce(
			(earliest, expiresAt) => Math.min(earliest, expiresAt),
			Number.POSITIVE_INFINITY,
		);
		if (Number.isFinite(nextExpiry)) {
			expiryTimer = setTimeout(refresh, Math.max(1, nextExpiry - now + 1));
			expiryTimer.unref?.();
		}
		ctx.ui.setWidget("pi-subagents", undefined);
		if (runtime.getConfig().showStatus && inspectable.length) {
			const totalCost = all
				.filter((run) => run.kind === "agent")
				.reduce((sum, run) => sum + run.usage.cost, 0);
			const activity = [
				runningAgents
					? `${formatCount(runningAgents, "agent")} running`
					: undefined,
				queuedAgents
					? `${formatCount(queuedAgents, "agent")} queued`
					: undefined,
				runningWorkflows
					? `${formatCount(runningWorkflows, "workflow")} running`
					: undefined,
				queuedWorkflows
					? `${formatCount(queuedWorkflows, "workflow")} queued`
					: undefined,
				recentFinishedAgents.length
					? `${formatCount(recentFinishedAgents.length, "agent")} finished`
					: undefined,
				recentFinishedWorkflows.length
					? `${formatCount(recentFinishedWorkflows.length, "workflow")} finished`
					: undefined,
			].filter((piece): piece is string => Boolean(piece));
			const inspectableJobs = inspectable.filter(
				(run) => run.kind === "workflow" || !run.parentRunId,
			).length;
			const pieces = [
				...(activity.length
					? activity
					: [`${formatCount(inspectableJobs, "run")} available`]),
				`$${totalCost.toFixed(2)}`,
				"/subagents-fleet",
				activeStandaloneAgents().length ? "Ctrl+B background" : undefined,
			].filter((piece): piece is string => Boolean(piece));
			const status = ctx.ui.theme.fg("accent", pieces.join(" · "));
			ctx.ui.setStatus("pi-subagents", status);
		} else {
			ctx.ui.setStatus("pi-subagents", undefined);
		}

		if (
			update?.run.background &&
			TERMINAL_STATES.has(update.run.state) &&
			!notified.has(update.run.id)
		) {
			notified.add(update.run.id);
			if (!observedRuns.has(update.run.id)) {
				const severity = update.run.state === "succeeded" ? "info" : "error";
				ctx.ui.notify(
					`${update.run.agent ?? update.run.workflow ?? "Run"} ${update.run.state}`,
					severity,
				);
			}
		}
	};
	refresh();
	const unsubscribe = runtime.subscribe(refresh);
	const unsubscribeInput =
		ctx.mode === "tui"
			? ctx.ui.onTerminalInput((data) => {
					if (!matchesKey(data, "ctrl+b")) return;
					const run = activeStandaloneAgents()[0];
					if (!run) return;
					try {
						const backgrounded = runtime.background(run.id, sessionId);
						ctx.ui.notify(
							`${runTitle(backgrounded)} moved to the background.`,
							"info",
						);
					} catch (error) {
						ctx.ui.notify(
							error instanceof Error ? error.message : String(error),
							"error",
						);
					}
					return { consume: true };
				})
			: undefined;
	return () => {
		unsubscribe();
		unsubscribeInput?.();
		if (expiryTimer) clearTimeout(expiryTimer);
		ctx.ui.setStatus("pi-subagents", undefined);
		ctx.ui.setWidget("pi-subagents", undefined);
	};
}

const KEY_NAMES: Readonly<Record<string, string>> = {
	escape: "Esc",
	enter: "Enter",
	up: "Up",
	down: "Down",
	left: "Left",
	right: "Right",
	pageup: "PageUp",
	pagedown: "PageDown",
	tab: "Tab",
	backspace: "Backspace",
	delete: "Delete",
	home: "Home",
	end: "End",
	space: "Space",
};

function keyLabel(key: string): string {
	return key
		.split("+")
		.map((part, index, parts) => {
			const lower = part.toLowerCase();
			if (lower === "ctrl") return "Ctrl";
			if (lower === "alt") return "Alt";
			if (lower === "shift") return "Shift";
			const named = KEY_NAMES[lower];
			if (named) return named;
			if (part.length === 1)
				return parts.length > 1 && index === parts.length - 1
					? part.toUpperCase()
					: part;
			return part.charAt(0).toUpperCase() + part.slice(1);
		})
		.join("+");
}

function configuredKeyGroup(
	keybindings: KeybindingsManager,
	bindings: Array<Parameters<KeybindingsManager["getKeys"]>[0]>,
	extra: string[] = [],
): string {
	const keys = bindings.flatMap((binding) =>
		keybindings.getKeys(binding).map(keyLabel),
	);
	return [...new Set([...keys, ...extra])].join("/") || "Unbound";
}

function fit(text: string, width: number): string {
	const clipped = truncateToWidth(text, Math.max(0, width), "");
	return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function splitColumns(left: string, right: string, width: number): string {
	if (!right) return truncateToWidth(left, width, "");
	const gap = width - visibleWidth(left) - visibleWidth(right);
	if (gap >= 1) return `${left}${" ".repeat(gap)}${right}`;
	const rightWidth = Math.min(
		visibleWidth(right),
		Math.max(1, Math.floor(width * 0.45)),
	);
	const fittedRight = truncateToWidth(right, rightWidth, "");
	const fittedLeft = truncateToWidth(
		left,
		Math.max(0, width - visibleWidth(fittedRight) - 1),
		"…",
	);
	return fit(`${fittedLeft} ${fittedRight}`, width);
}

function panel(
	theme: ExtensionContext["ui"]["theme"],
	title: string,
	rows: string[],
	width: number,
	height: number,
	focused = false,
): string[] {
	const inner = Math.max(0, width - 2);
	const borderColor = focused ? "borderAccent" : "borderMuted";
	const border = (text: string) => theme.fg(borderColor, text);
	const titleText = truncateToWidth(` ${title} `, Math.max(0, inner - 2), "");
	const topFill = Math.max(0, inner - visibleWidth(titleText) - 1);
	const lines = [
		`${border("╭─")}${theme.fg(focused ? "accent" : "muted", theme.bold(titleText))}${border(`${"─".repeat(topFill)}╮`)}`,
	];
	for (let index = 0; index < Math.max(0, height - 2); index++) {
		lines.push(`${border("│")}${fit(rows[index] ?? "", inner)}${border("│")}`);
	}
	lines.push(border(`╰${"─".repeat(inner)}╯`));
	return lines.map((line) => truncateToWidth(line, width, ""));
}

function orderFleetRuns(runs: RunRecord[]): RunRecord[] {
	const known = new Set(runs.map((run) => run.id));
	const children = new Map<string, RunRecord[]>();
	const roots: RunRecord[] = [];
	for (const run of runs) {
		if (run.parentRunId && known.has(run.parentRunId)) {
			const entries = children.get(run.parentRunId) ?? [];
			entries.push(run);
			children.set(run.parentRunId, entries);
		} else roots.push(run);
	}
	const ordered: RunRecord[] = [];
	const append = (run: RunRecord) => {
		ordered.push(run);
		for (const child of children.get(run.id) ?? []) append(child);
	};
	for (const root of roots) append(root);
	return ordered;
}

class FleetComponent implements Component {
	private selected = 0;
	private outputScroll = 0;
	private runs: RunRecord[] = [];
	private timer: ReturnType<typeof setInterval>;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		private readonly theme: ExtensionContext["ui"]["theme"],
		private readonly keybindings: KeybindingsManager,
		private readonly runtime: SubagentRuntime,
		private readonly sessionId: string,
		private readonly done: () => void,
	) {
		this.refresh();
		this.timer = setInterval(() => {
			if (!this.disposed) {
				this.refresh();
				this.tui.requestRender();
			}
		}, 750);
		this.timer.unref?.();
	}

	private refresh(): void {
		const selectedId = this.runs[this.selected]?.id;
		this.runs = orderFleetRuns(
			inspectableFleetRuns(
				this.runtime.listForSession(this.sessionId, ALL_SESSION_RUNS),
			),
		);
		const next = selectedId
			? this.runs.findIndex((run) => run.id === selectedId)
			: -1;
		this.selected =
			next >= 0
				? next
				: Math.min(
						Math.max(0, this.selected),
						Math.max(0, this.runs.length - 1),
					);
		if (selectedId && this.runs[this.selected]?.id !== selectedId)
			this.outputScroll = 0;
	}

	handleInput(data: string): void {
		if (
			this.keybindings.matches(data, "tui.select.cancel") ||
			this.keybindings.matches(data, "app.interrupt") ||
			data === "q"
		) {
			this.done();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up")) {
			const previous = this.selected;
			this.selected = Math.max(0, this.selected - 1);
			if (this.selected !== previous) this.outputScroll = 0;
		} else if (this.keybindings.matches(data, "tui.select.down")) {
			const previous = this.selected;
			this.selected = Math.min(
				Math.max(0, this.runs.length - 1),
				this.selected + 1,
			);
			if (this.selected !== previous) this.outputScroll = 0;
		} else if (data === "g") {
			this.selected = 0;
			this.outputScroll = 0;
		} else if (data === "G") {
			this.selected = Math.max(0, this.runs.length - 1);
			this.outputScroll = 0;
		} else if (data === "k")
			this.outputScroll = Math.max(0, this.outputScroll - 1);
		else if (data === "j") this.outputScroll += 1;
		else if (data === "b") {
			const run = this.runs[this.selected];
			if (run) {
				try {
					this.runtime.background(run.id, this.sessionId);
				} catch {
					/* selected run cannot be backgrounded */
				}
			}
			this.refresh();
		} else if (data === "r") this.refresh();
		this.tui.requestRender();
	}

	render(width: number): string[] {
		if (width < 60)
			return [
				truncateToWidth(
					"Subagent fleet needs at least 60 columns. Esc closes.",
					width,
				),
			];
		const terminalRows = this.tui.terminal?.rows ?? 30;
		const panelHeight = Math.max(8, Math.min(20, terminalRows - 8));
		const bodyHeight = panelHeight - 2;
		const leftWidth = Math.max(28, Math.floor(width * 0.38));
		const rightWidth = width - leftWidth - 1;
		const leftInner = leftWidth - 2;
		const rightInner = rightWidth - 2;
		const activeCount = this.runs.filter(
			(run) =>
				!TERMINAL_STATES.has(run.state) &&
				(run.kind === "workflow" || !run.parentRunId),
		).length;
		const header = splitColumns(
			` ${this.theme.bold(this.theme.fg("accent", "Subagent fleet"))}`,
			this.theme.fg(
				"dim",
				`${activeCount} active · ${this.runs.length} recent · current session `,
			),
			width,
		);
		const start = Math.max(
			0,
			Math.min(
				this.selected - bodyHeight + 1,
				Math.max(0, this.runs.length - bodyHeight),
			),
		);
		const leftRows = this.runs
			.slice(start, start + bodyHeight)
			.map((run, offset) => {
				const index = start + offset;
				const selected = index === this.selected;
				const marker = selected ? this.theme.fg("accent", "❯") : " ";
				const square = this.theme.fg(stateColor(run.state), "■");
				const nested = run.parentRunId ? "  ↳ " : " ";
				const rawName = run.stepId ?? runTitle(run);
				const name = selected
					? this.theme.fg("accent", rawName)
					: this.theme.fg("text", rawName);
				const left = `${marker}${nested}${square} ${name}`;
				return splitColumns(left, this.theme.fg("dim", run.state), leftInner);
			});
		const run = this.runs[this.selected];
		const children = run
			? this.runs.filter((candidate) => candidate.parentRunId === run.id)
			: [];
		const childSummary = children.length
			? `${children.filter((child) => child.state === "succeeded").length}/${children.length} child agents`
			: undefined;
		const detail = (label: string, value: string) =>
			`${this.theme.fg("dim", label.padEnd(10))}${value}`;
		const rawDetails = run
			? [
					detail("Run", this.theme.fg("text", run.id)),
					detail(
						"State",
						`${this.theme.fg(stateColor(run.state), "■")} ${this.theme.fg(stateColor(run.state), run.state)}`,
					),
					detail("Kind", run.kind),
					...(run.stepId ? [detail("Step", run.stepId)] : []),
					detail("Elapsed", duration(run)),
					...(childSummary ? [detail("Progress", childSummary)] : []),
					detail("Model", modelLabel(run.model) ?? "inherit"),
					detail("Effort", run.thinking ? `${run.thinking} effort` : "inherit"),
					...(run.difficulty
						? [detail("Difficulty", String(run.difficulty))]
						: []),
					detail("Usage", usageLine(run) || "-"),
					detail("Activity", run.activity?.message ?? "-"),
					detail("Cwd", run.cwd),
					...(run.outputArtifact ? [detail("Output", run.outputArtifact)] : []),
					...(run.patchArtifact ? [detail("Patch", run.patchArtifact)] : []),
					"",
					this.theme.fg("muted", "Result"),
					...(run.output ?? run.error?.message ?? "(no output)")
						.split("\n")
						.map((line) => this.theme.fg("toolOutput", line)),
				]
			: [this.theme.fg("dim", "No recorded runs.")];
		const wrapped = rawDetails.flatMap((line) =>
			wrapTextWithAnsi(line, rightInner),
		);
		const maxScroll = Math.max(0, wrapped.length - bodyHeight);
		this.outputScroll = Math.min(this.outputScroll, maxScroll);
		const rightRows = wrapped.slice(
			this.outputScroll,
			this.outputScroll + bodyHeight,
		);
		const leftPanel = panel(
			this.theme,
			`Runs · ${this.runs.length}`,
			leftRows,
			leftWidth,
			panelHeight,
		);
		const rightPanel = panel(
			this.theme,
			run ? `${runTitle(run)} · ${run.kind}` : "Details",
			rightRows,
			rightWidth,
			panelHeight,
			true,
		);
		const lines = [header];
		for (let index = 0; index < panelHeight; index++)
			lines.push(`${leftPanel[index] ?? ""} ${rightPanel[index] ?? ""}`);
		const selectKeys = configuredKeyGroup(this.keybindings, [
			"tui.select.up",
			"tui.select.down",
		]);
		const closeKeys = configuredKeyGroup(
			this.keybindings,
			["tui.select.cancel", "app.interrupt"],
			["q"],
		);
		lines.push(
			truncateToWidth(
				this.theme.fg(
					"dim",
					` ${selectKeys} select · g/G first/last · j/k scroll output · b background · r refresh · ${closeKeys} close`,
				),
				width,
				"",
			),
		);
		return lines.map((line) => truncateToWidth(line, width, ""));
	}

	invalidate(): void {
		this.refresh();
	}
	dispose(): void {
		this.disposed = true;
		clearInterval(this.timer);
	}
}

export async function openFleet(
	ctx: ExtensionContext,
	runtime: SubagentRuntime,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(
			"The fleet overlay is available in TUI mode only.",
			"warning",
		);
		return;
	}
	const sessionId = ctx.sessionManager.getSessionId();
	const existing = getFleetOverlayState(runtime, sessionId);
	if (existing) {
		existing.handle?.focus();
		return;
	}
	const state = beginFleetOverlay(runtime, sessionId);
	if (!state) return;
	try {
		await ctx.ui.custom<undefined>(
			(tui, theme, keybindings, done) => {
				let closed = false;
				const close = () => {
					if (closed) return;
					closed = true;
					state.close = undefined;
					endFleetOverlay(runtime, sessionId, state);
					done(undefined);
				};
				state.close = close;
				return new FleetComponent(
					tui,
					theme,
					keybindings,
					runtime,
					sessionId,
					close,
				);
			},
			{
				overlay: true,
				overlayOptions: {
					anchor: "center",
					width: "94%",
					minWidth: 60,
					maxHeight: "90%",
					margin: 1,
				},
				onHandle: (handle) => {
					state.handle = handle;
					handle.focus();
				},
			},
		);
	} finally {
		state.close = undefined;
		endFleetOverlay(runtime, sessionId, state);
	}
}
