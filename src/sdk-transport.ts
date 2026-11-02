import { type ChildProcess, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createByteTail } from "./protocol.ts";
import { type CliTransportOptions, terminateProcessTree } from "./transport.ts";
import type { TransportEvent, TransportResult, UsageStats } from "./types.ts";

const emptyUsage = (): UsageStats => ({
	turns: 0,
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
});

/** Each scheduled invocation gets an isolated process; canonical session state persists. */
export async function runSdkAgent(
	options: CliTransportOptions,
): Promise<TransportResult> {
	const { request, signal } = options;
	if (!fs.statSync(request.cwd).isDirectory())
		throw new Error(`Child cwd is not a directory: ${request.cwd}`);
	const failure = (
		state: "failed" | "cancelled" | "timed_out",
		message: string,
	): TransportResult => ({
		state,
		output: "",
		usage: emptyUsage(),
		error: { code: state, message, retryable: false },
		transcript: [],
		truncated: false,
	});
	if (signal.aborted)
		return failure("cancelled", "Child cancelled before startup.");
	const executable = /^(node|nodejs)(\.exe)?$/i.test(
		path.basename(process.execPath),
	)
		? process.execPath
		: "node";
	const env = {
		...process.env,
		PI_SUBAGENT_DEPTH: "1",
		PI_SUBAGENT_PARENT_RUN: options.runId,
	};
	for (const key of [
		"PI_SESSION_ID",
		"PI_SESSION_FILE",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
	])
		delete (env as NodeJS.ProcessEnv)[key];
	const stderr = createByteTail();
	let result: TransportResult | undefined;
	let reason: "cancelled" | "timed_out" | undefined;
	let hostError: string | undefined;
	let lastUsage = emptyUsage();
	let child: ChildProcess;
	let termination: Promise<void> | undefined;
	let grace: ReturnType<typeof setTimeout> | undefined;
	let settled = false;
	const terminate = () => {
		termination ??= terminateProcessTree(child).catch((error: unknown) => {
			hostError = `Child cleanup failed: ${error instanceof Error ? error.message : String(error)}`;
		});
	};
	const abort = (kind: "cancelled" | "timed_out") => {
		reason ??= kind;
		if (child.connected) child.send({ type: "abort" }, () => {});
		grace ??= setTimeout(terminate, 250);
	};
	const onAbort = () => abort("cancelled");
	child = spawn(
		executable,
		[
			"--import",
			import.meta.resolve("jiti/register"),
			fileURLToPath(new URL("./child-host.ts", import.meta.url)),
		],
		{
			cwd: request.cwd,
			env,
			detached: process.platform !== "win32",
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe", "ipc"],
		},
	);
	const closed = new Promise<void>((resolve) => {
		child.once("close", () => resolve());
	});
	child.on("error", (error: NodeJS.ErrnoException) => {
		hostError ??=
			child.pid === undefined
				? `Could not start SDK child with Node.js executable "${executable}": ${error.message}${
						error.code === "ENOENT"
							? "\nIf Node.js was upgraded or removed while Pi was running, restart Pi to use the current executable. Otherwise, check that the executable and child working directory exist."
							: ""
					}`
				: error.message;
	});
	// A dead leader can leave descendants holding stdout open; don't wait for
	// the run timeout before reaping that process group and reaching close.
	child.once("exit", terminate);
	child.stdout?.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	child.on("message", (raw: unknown) => {
		if (!raw || typeof raw !== "object") return;
		const message = raw as {
			type?: string;
			event?: TransportEvent;
			result?: TransportResult;
			message?: string;
		};
		if (message.type === "event" && message.event) {
			if (message.event.type === "settled") settled = true;
			if (message.event.type === "usage")
				lastUsage = { ...lastUsage, ...message.event.data } as UsageStats;
			options.onEvent?.(message.event);
		} else if (message.type === "result" && message.result) {
			if (result) {
				hostError = "Child returned multiple final results.";
			} else result = message.result;
			terminate();
		} else if (message.type === "host_error") {
			hostError = message.message ?? "Child host failed.";
			terminate();
		}
	});
	const timeout = setTimeout(() => abort("timed_out"), request.timeoutMs);
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	// Sending before spawn succeeds can mask ENOENT/EACCES with write EPIPE.
	child.once("spawn", () => {
		options.onEvent?.({ type: "started", data: { pid: child.pid } });
		if (reason) return;
		child.send(
			{
				type: "invoke",
				input: {
					request,
					sessionFile:
						request.childSessionFile ??
						path.join(options.runDirectory, "session.json"),
					resultMaxBytes: options.resultMaxBytes,
					transcriptMaxEvents: options.transcriptMaxEvents,
				},
			},
			(error) => {
				if (error) {
					hostError ??= error.message;
					terminate();
				}
			},
		);
	});
	try {
		await closed;
	} finally {
		clearTimeout(timeout);
		if (grace) clearTimeout(grace);
		signal.removeEventListener("abort", onAbort);
		terminate();
		await termination;
	}
	if (reason)
		result = {
			...failure(
				reason,
				reason === "timed_out"
					? `Child exceeded ${request.timeoutMs}ms.`
					: "Child cancelled.",
			),
			usage: result?.usage ?? lastUsage,
		};
	else if (hostError || !result || !settled)
		result = {
			...failure(
				"failed",
				hostError ??
					"Child exited without an authoritative result and agent_settled watermark.",
			),
			usage: result?.usage ?? lastUsage,
		};
	return {
		...result,
		pid: child.pid,
		stderr: stderr.text(),
	} as TransportResult;
}
