import assert from "node:assert/strict";
import test from "node:test";
import { Scheduler } from "../src/scheduler.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("scheduler enforces concurrency and resource leases", async () => {
	const scheduler = new Scheduler(3);
	let active = 0;
	let maximum = 0;
	const timeline: string[] = [];
	const run = (name: string, resource?: string) =>
		scheduler.run(
			async () => {
				active++;
				maximum = Math.max(maximum, active);
				timeline.push(`start:${name}`);
				await sleep(20);
				timeline.push(`end:${name}`);
				active--;
				return name;
			},
			{ priority: "foreground", resources: resource ? [resource] : [] },
		);
	const values = await Promise.all([
		run("a", "workspace"),
		run("b", "workspace"),
		run("c"),
		run("d"),
	]);
	assert.deepEqual(values, ["a", "b", "c", "d"]);
	assert.ok(maximum <= 3);
	assert.ok(timeline.indexOf("start:b") > timeline.indexOf("end:a"));
});

test("foreground queued work precedes background work", async () => {
	const scheduler = new Scheduler(1);
	const order: string[] = [];
	let release!: () => void;
	const blocker = scheduler.run(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		{ priority: "foreground" },
	);
	await sleep(1);
	const background = scheduler.run(
		async () => {
			order.push("background");
		},
		{ priority: "background" },
	);
	const foreground = scheduler.run(
		async () => {
			order.push("foreground");
		},
		{ priority: "foreground" },
	);
	release();
	await Promise.all([blocker, background, foreground]);
	assert.deepEqual(order, ["foreground", "background"]);
});

test("queued cancellation removes work", async () => {
	const scheduler = new Scheduler(1);
	let release!: () => void;
	const blocker = scheduler.run(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
		{ priority: "foreground" },
	);
	await sleep(1);
	const controller = new AbortController();
	const queued = scheduler.run(async () => "unexpected", {
		priority: "foreground",
		signal: controller.signal,
	});
	controller.abort(new Error("cancel test"));
	await assert.rejects(queued, /cancel test/);
	release();
	await blocker;
});
