import { defineWorkflow } from "../src/workflow-api.ts";

function requestOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (
		input &&
		typeof input === "object" &&
		typeof (input as { request?: unknown }).request === "string"
	)
		return (input as { request: string }).request;
	throw new Error("scout-plan input must be a string or { request: string }.");
}

export default defineWorkflow({
	name: "scout-plan",
	description:
		"Inspect relevant code, then produce a grounded implementation plan.",
	async run(ctx, input: unknown) {
		const request = requestOf(input);
		const context = await ctx.agent("scout", {
			agent: "scout",
			task: `Inspect the repository for this request and return a compact implementation handoff:\n\n${request}`,
		});
		const plan = await ctx.agent("plan", {
			agent: "planner",
			task: `Create an implementation plan for the request below. Use the scout evidence, verify details in the repository, and do not edit files.\n\nRequest:\n${request}\n\nScout evidence:\n${context.output}`,
		});
		return plan.output;
	},
});
