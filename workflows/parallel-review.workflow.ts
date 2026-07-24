import { defineWorkflow } from "../src/workflow-api.ts";

function requestOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (
		input &&
		typeof input === "object" &&
		typeof (input as { request?: unknown }).request === "string"
	)
		return (input as { request: string }).request;
	throw new Error(
		"parallel-review input must be a string or { request: string }.",
	);
}

export default defineWorkflow({
	name: "parallel-review",
	description:
		"Run independent correctness, test, and simplicity reviews concurrently.",
	async run(ctx, input: unknown) {
		const request = requestOf(input);
		const focuses = [
			"correctness and regressions",
			"test coverage and edge cases",
			"simplicity and maintainability",
		];
		const reviews = await ctx.map(
			"reviews",
			focuses,
			(focus) => ({
				agent: "reviewer",
				task: `Review the implementation related to this request, focusing on ${focus}. Inspect current repository files, do not edit, and report only actionable findings with evidence.\n\nRequest:\n${request}`,
			}),
			{ concurrency: 3 },
		);
		return reviews
			.map((review, index) => `## ${focuses[index]}\n\n${review.output}`)
			.join("\n\n");
	},
});
