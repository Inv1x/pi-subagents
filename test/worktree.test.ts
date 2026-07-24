import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { createWorktree } from "../src/worktree.ts";

function git(cwd: string, args: string[]): void {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
	if (result.status !== 0)
		throw new Error(result.stderr || `git ${args.join(" ")} failed`);
}

test("worktree captures a patch and cleans up", {
	skip: !process.env.PATH,
}, () => {
	const repository = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-subagents-git-"),
	);
	try {
		git(repository, ["init", "-q"]);
		git(repository, ["config", "user.email", "tests@example.com"]);
		git(repository, ["config", "user.name", "Tests"]);
		fs.writeFileSync(path.join(repository, "file.txt"), "before\n");
		git(repository, ["add", "file.txt"]);
		git(repository, ["commit", "-qm", "initial"]);
		const handle = createWorktree(repository, "agent_abcdef123456");
		fs.writeFileSync(path.join(handle.cwd, "file.txt"), "after\n");
		const patchPath = path.join(repository, "result.patch");
		const captured = handle.capturePatch(patchPath);
		assert.equal(captured.patchPath, patchPath);
		assert.match(fs.readFileSync(patchPath, "utf8"), /\+after/);
		const worktreePath = handle.path;
		handle.cleanup();
		assert.equal(fs.existsSync(worktreePath), false);
	} finally {
		fs.rmSync(repository, { recursive: true, force: true });
	}
});
