import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface GitResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

function git(cwd: string, args: string[]): GitResult {
	const result = spawnSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		windowsHide: true,
	});
	return {
		status: result.status,
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
	};
}

function checked(cwd: string, args: string[]): string {
	const result = git(cwd, args);
	if (result.status !== 0)
		throw new Error(
			result.stderr.trim() ||
				result.stdout.trim() ||
				`git ${args.join(" ")} failed`,
		);
	return result.stdout;
}

export interface WorktreeHandle {
	repoRoot: string;
	path: string;
	cwd: string;
	branch: string;
	baseCommit: string;
	capturePatch(destination: string): { patchPath?: string; summary: string };
	cleanup(): void;
}

export function createWorktree(
	sourceCwd: string,
	runId: string,
): WorktreeHandle {
	if (
		git(sourceCwd, ["rev-parse", "--is-inside-work-tree"]).stdout.trim() !==
		"true"
	) {
		throw new Error("Worktree isolation requires a Git repository.");
	}
	const repoRoot = checked(sourceCwd, ["rev-parse", "--show-toplevel"]).trim();
	const relativeCwd = checked(sourceCwd, ["rev-parse", "--show-prefix"])
		.trim()
		.replace(/[\\/]$/, "");
	if (checked(repoRoot, ["status", "--porcelain"]).trim()) {
		throw new Error(
			"Worktree isolation requires a clean Git working tree. Commit or stash changes first.",
		);
	}
	const baseCommit = checked(repoRoot, ["rev-parse", "HEAD"]).trim();
	const branch = `pi-subagent-${runId}`;
	const worktreePath = path.join(os.tmpdir(), `pi-subagent-${runId}`);
	const added = git(repoRoot, [
		"worktree",
		"add",
		"-b",
		branch,
		worktreePath,
		baseCommit,
	]);
	if (added.status !== 0)
		throw new Error(
			added.stderr.trim() || `Could not create worktree ${worktreePath}`,
		);
	const childCwd = relativeCwd
		? path.join(worktreePath, relativeCwd)
		: worktreePath;
	const sourceModules = path.join(repoRoot, "node_modules");
	const targetModules = path.join(worktreePath, "node_modules");
	if (fs.existsSync(sourceModules) && !fs.existsSync(targetModules)) {
		try {
			fs.symlinkSync(
				sourceModules,
				targetModules,
				process.platform === "win32" ? "junction" : "dir",
			);
		} catch {
			/* optional */
		}
	}

	let cleaned = false;
	return {
		repoRoot,
		path: worktreePath,
		cwd: childCwd,
		branch,
		baseCommit,
		capturePatch(destination) {
			try {
				try {
					fs.rmSync(targetModules, { recursive: true, force: true });
				} catch {
					/* optional link */
				}
				checked(worktreePath, ["add", "-A"]);
				const patch = checked(worktreePath, [
					"diff",
					"--cached",
					"--binary",
					baseCommit,
				]);
				const summary = checked(worktreePath, [
					"diff",
					"--cached",
					"--stat",
					baseCommit,
				]).trim();
				if (!patch.trim()) return { summary: "No worktree changes." };
				fs.mkdirSync(path.dirname(destination), {
					recursive: true,
					mode: 0o700,
				});
				fs.writeFileSync(destination, patch, { encoding: "utf8", mode: 0o600 });
				return {
					patchPath: destination,
					summary: summary || "Worktree produced changes.",
				};
			} catch (error) {
				return {
					summary: `Could not capture worktree patch: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		},
		cleanup() {
			if (cleaned) return;
			cleaned = true;
			try {
				checked(repoRoot, ["worktree", "remove", "--force", worktreePath]);
			} catch {
				/* best effort */
			}
			try {
				checked(repoRoot, ["branch", "-D", branch]);
			} catch {
				/* best effort */
			}
			try {
				checked(repoRoot, ["worktree", "prune"]);
			} catch {
				/* best effort */
			}
		},
	};
}
