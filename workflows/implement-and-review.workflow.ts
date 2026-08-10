import { Type } from "typebox";
import { defineWorkflow } from "../src/workflow-api.ts";

const RequestInput = Type.Union([
	Type.String(),
	Type.Object({ request: Type.String() }, { additionalProperties: false }),
]);

function requestOf(input: unknown): string {
	if (typeof input === "string") return input;
	if (
		input &&
		typeof input === "object" &&
		typeof (input as { request?: unknown }).request === "string"
	)
		return (input as { request: string }).request;
	throw new Error(
		"implement-and-review input must be a string or { request: string }.",
	);
}

export default defineWorkflow({
	name: "implement-and-review",
	description:
		"Scout, plan, implement, review concurrently, and apply valid fixes.",
	input: RequestInput,
	output: Type.String(),
	async run(ctx, input: unknown) {
		const request = requestOf(input);
		const context = await ctx.agent("scout", {
			agent: "scout",
			context: "summary",
			difficulty: 3,
			task: `Map the code relevant to this implementation request. Do not edit.\n\n${request}`,
		});
		const plan = await ctx.agent("plan", {
			agent: "planner",
			difficulty: 4,
			task: `Produce a concrete implementation plan.\n\nRequest:\n${request}\n\nCode context:\n${context.output}`,
		});
		const implementation = await ctx.agent("implement", {
			agent: "worker",
			difficulty: 4,
			task: `Implement this request and validate it.\n\nRequest:\n${request}\n\nPlan:\n${plan.output}`,
		});
		const focuses = [
			"correctness and regressions",
			"tests and edge cases",
			"unnecessary complexity",
		];
		const reviews = await ctx.map(
			"reviews",
			focuses,
			(focus) => ({
				agent: "reviewer",
				difficulty: 3,
				task: `Review the current implementation for ${focus}. Do not edit files.\n\nOriginal request:\n${request}\n\nImplementation report:\n${implementation.output}`,
			}),
			{ concurrency: 3 },
		);
		const findings = reviews
			.map((review, index) => `### ${focuses[index]}\n${review.output}`)
			.join("\n\n");
		const final = await ctx.agent("fix-review-findings", {
			agent: "worker",
			difficulty: 4,
			task: `Inspect these independent review reports. Apply only valid findings, keep the implementation in scope, and run focused validation.\n\nOriginal request:\n${request}\n\nReview reports:\n${findings}`,
		});
		return final.output;
	},
});
