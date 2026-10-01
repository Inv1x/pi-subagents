import { type ChildInvocation, IsolatedChildSession } from "./child-session.ts";

// IPC is separate from stdout: tools and diagnostics cannot forge protocol lines.
const child = new IsolatedChildSession();
let busy = false;
const send = (value: object) => {
	if (process.connected) process.send?.(value);
};
process.on("message", (raw: unknown) => {
	if (!raw || typeof raw !== "object") return;
	const command = raw as { type?: string; input?: ChildInvocation };
	if (command.type === "abort") {
		void child.abort();
		return;
	}
	if (command.type !== "invoke" || !command.input || busy) {
		send({
			type: "host_error",
			message: "Invalid or concurrent child invocation.",
		});
		return;
	}
	busy = true;
	void child
		.invoke(command.input, (event) => send({ type: "event", event }))
		.then((result) => send({ type: "result", result }))
		.catch((error) =>
			send({
				type: "host_error",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
});
process.on("disconnect", () => {
	void child.abort().finally(() => {
		child.dispose();
		process.exit(0);
	});
});
