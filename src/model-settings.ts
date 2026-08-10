import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import {
	DynamicBorder,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Container,
	fuzzyFilter,
	Input,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import {
	deleteAgentModelsFile,
	projectConfigPath,
	readAgentModelsFile,
	userConfigPath,
	writeAgentModelsFile,
} from "./config.ts";
import { THINKING_LEVELS } from "./model-options.ts";
import type {
	AgentDefinition,
	AgentModelProfile,
	Difficulty,
} from "./types.ts";

const DIFFICULTY_LABELS: Record<Difficulty, string> = {
	1: "trivial",
	2: "light",
	3: "standard",
	4: "complex",
	5: "critical",
};

function profileLabel(profile: AgentModelProfile): string {
	return `≤${profile.maxDifficulty} ${DIFFICULTY_LABELS[profile.maxDifficulty]} · ${profile.model} · ${profile.thinking} effort`;
}

async function pickOption(
	ctx: ExtensionContext,
	title: string,
	items: readonly SelectItem[],
	current?: string,
): Promise<string | undefined> {
	if (ctx.mode !== "tui") {
		const labels = items.map((item) => item.label);
		const selected = await ctx.ui.select(title, labels);
		return items.find((item) => item.label === selected)?.value;
	}
	return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
		const container = new Container();
		const input = new Input();
		const listContainer = new Container();
		let list: SelectList;
		const listTheme = {
			selectedPrefix: (text: string) => theme.fg("accent", text),
			selectedText: (text: string) => theme.fg("accent", text),
			description: (text: string) => theme.fg("muted", text),
			scrollInfo: (text: string) => theme.fg("dim", text),
			noMatch: (text: string) => theme.fg("warning", text),
		};
		const rebuildList = () => {
			const query = input.getValue();
			const filtered = query
				? fuzzyFilter(
						[...items],
						query,
						(item) => `${item.label} ${item.description ?? ""}`,
					)
				: [...items];
			list = new SelectList(
				filtered,
				Math.min(filtered.length || 1, 10),
				listTheme,
			);
			if (!query && current) {
				list.setSelectedIndex(
					Math.max(
						0,
						filtered.findIndex((item) => item.value === current),
					),
				);
			}
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(undefined);
			listContainer.clear();
			listContainer.addChild(list);
		};
		container.addChild(
			new DynamicBorder((text: string) => theme.fg("accent", text)),
		);
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		container.addChild(
			new Text(
				theme.fg("dim", "Type to search, ↑↓ navigate, Enter select"),
				1,
				0,
			),
		);
		container.addChild(input);
		container.addChild(new Spacer(1));
		container.addChild(listContainer);
		container.addChild(
			new DynamicBorder((text: string) => theme.fg("accent", text)),
		);
		rebuildList();
		return {
			get focused() {
				return input.focused;
			},
			set focused(value: boolean) {
				input.focused = value;
			},
			render: (width: number) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (
					keybindings.matches(data, "tui.select.up") ||
					keybindings.matches(data, "tui.select.down") ||
					keybindings.matches(data, "tui.select.confirm") ||
					keybindings.matches(data, "tui.select.cancel")
				) {
					list.handleInput(data);
				} else {
					input.handleInput(data);
					rebuildList();
				}
				tui.requestRender();
			},
		};
	});
}

async function chooseProfile(
	ctx: ExtensionContext,
	existing?: AgentModelProfile,
): Promise<AgentModelProfile | undefined> {
	await ctx.modelRegistry.refresh();
	const available = (
		ctx.scopedModels.length > 0
			? ctx.scopedModels.map(({ model }) => model)
			: ctx.modelRegistry.getAvailable()
	)
		.map((model) => ({ model, id: `${model.provider}/${model.id}` }))
		.sort((a, b) => a.id.localeCompare(b.id));
	if (!available.length) {
		ctx.ui.notify("No authenticated models are available.", "warning");
		return undefined;
	}
	const modelOptions: SelectItem[] = available.map((item) => ({
		value: item.id,
		label: item.id,
		description: item.model.name,
	}));
	if (
		existing &&
		ctx.scopedModels.length === 0 &&
		!modelOptions.some((item) => item.value === existing.model)
	) {
		modelOptions.unshift({
			value: existing.model,
			label: existing.model,
			description: "currently unavailable",
		});
	}
	const selectedId = await pickOption(
		ctx,
		"Choose a child model",
		modelOptions,
		existing?.model,
	);
	if (!selectedId) return undefined;
	const selectedModel = available.find((item) => item.id === selectedId)?.model;
	const levels = selectedModel
		? getSupportedThinkingLevels(selectedModel)
		: THINKING_LEVELS;
	const selectedThinking = await pickOption(
		ctx,
		"Choose thinking effort",
		levels.map((level) => ({ value: level, label: level })),
		existing?.thinking,
	);
	if (!selectedThinking) return undefined;
	const difficultyOptions = ([1, 2, 3, 4, 5] as const).map((value) => ({
		value: String(value),
		label: `${value} — ${DIFFICULTY_LABELS[value]}`,
	}));
	const selectedDifficulty = await pickOption(
		ctx,
		"Use this profile through difficulty",
		difficultyOptions,
		existing ? String(existing.maxDifficulty) : undefined,
	);
	if (!selectedDifficulty) return undefined;
	return {
		model: selectedId,
		thinking: selectedThinking as AgentModelProfile["thinking"],
		maxDifficulty: Number(selectedDifficulty) as Difficulty,
	};
}

export async function openAgentModelSettings(
	ctx: ExtensionContext,
	agents: readonly AgentDefinition[],
	requestedAgent?: string,
): Promise<boolean> {
	if (!ctx.hasUI) {
		ctx.ui.notify("/subagent-models requires an interactive UI.", "error");
		return false;
	}
	let agent = requestedAgent?.trim();
	if (agent && !agents.some((candidate) => candidate.name === agent)) {
		ctx.ui.notify(`Unknown agent '${agent}'.`, "error");
		return false;
	}
	if (!agent) {
		agent = await pickOption(
			ctx,
			"Configure models for which agent?",
			agents.map((candidate) => ({
				value: candidate.name,
				label: candidate.name,
				description: candidate.description,
			})),
		);
	}
	if (!agent) return false;

	let target = userConfigPath();
	let scope = "user";
	if (ctx.isProjectTrusted()) {
		const selectedScope = await ctx.ui.select("Save model profiles where?", [
			"User settings",
			"Project settings",
		]);
		if (!selectedScope) return false;
		if (selectedScope === "Project settings") {
			target = projectConfigPath(ctx.cwd);
			scope = "project";
		}
	}

	const local = readAgentModelsFile(target);
	const hasLocalOverride = Object.hasOwn(local, agent);
	const effectiveUser = readAgentModelsFile(userConfigPath());
	const inherited = scope === "project" ? effectiveUser[agent] : undefined;
	let profiles = [...(local[agent] ?? inherited ?? [])];
	let dirty = false;

	while (true) {
		const rows = profiles.map(profileLabel);
		const sourceLabel =
			scope === "project" && !hasLocalOverride && !dirty
				? " (inheriting user settings)"
				: dirty
					? " (unsaved)"
					: "";
		const action = await ctx.ui.select(
			`${agent} model profiles${sourceLabel}`,
			[
				...rows,
				"＋ Add profile",
				...(profiles.length ? ["× Disable routing (empty profiles)"] : []),
				...(scope === "project" && hasLocalOverride
					? ["↩ Remove project override"]
					: []),
				"✓ Save and close",
				"Cancel",
			],
		);
		if (!action || action === "Cancel") return false;
		if (action === "✓ Save and close") {
			if (!dirty) {
				ctx.ui.notify("No model profile changes to save.", "info");
				return false;
			}
			writeAgentModelsFile(target, agent, profiles);
			ctx.ui.notify(
				`Saved ${profiles.length} ${agent} model profile${profiles.length === 1 ? "" : "s"} to ${target}.`,
				"info",
			);
			return true;
		}
		if (action === "＋ Add profile") {
			const created = await chooseProfile(ctx);
			if (!created) continue;
			profiles = [
				...profiles.filter(
					(profile) => profile.maxDifficulty !== created.maxDifficulty,
				),
				created,
			].sort((a, b) => a.maxDifficulty - b.maxDifficulty);
			dirty = true;
			continue;
		}
		if (action === "× Disable routing (empty profiles)") {
			profiles = [];
			dirty = true;
			continue;
		}
		if (action === "↩ Remove project override") {
			deleteAgentModelsFile(target, agent);
			ctx.ui.notify(
				`Removed the ${agent} project override; user model profiles now apply.`,
				"info",
			);
			return true;
		}
		const index = rows.indexOf(action);
		if (index < 0) continue;
		const selected = profiles[index];
		if (!selected) continue;
		const profileAction = await ctx.ui.select(profileLabel(selected), [
			"Edit",
			"Delete",
			"Back",
		]);
		if (profileAction === "Delete") {
			profiles.splice(index, 1);
			dirty = true;
		} else if (profileAction === "Edit") {
			const updated = await chooseProfile(ctx, selected);
			if (!updated) continue;
			profiles = [
				...profiles.filter(
					(_profile, profileIndex) =>
						profileIndex !== index &&
						_profile.maxDifficulty !== updated.maxDifficulty,
				),
				updated,
			].sort((a, b) => a.maxDifficulty - b.maxDifficulty);
			dirty = true;
		}
	}
}
