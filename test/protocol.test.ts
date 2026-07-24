import assert from "node:assert/strict";
import test from "node:test";
import {
	createByteTail,
	createLineReader,
	truncateUtf8,
} from "../src/protocol.ts";

test("line reader preserves split UTF-8 and final unterminated lines", () => {
	const lines: string[] = [];
	const limits: unknown[] = [];
	const reader = createLineReader({
		onLine: (line) => lines.push(line),
		onLimit: (error) => limits.push(error),
	});
	const bytes = Buffer.from('{"text":"héllo"}\nlast');
	reader.push(bytes.subarray(0, 10));
	reader.push(bytes.subarray(10, 14));
	reader.push(bytes.subarray(14));
	reader.end();
	assert.deepEqual(lines, ['{"text":"héllo"}', "last"]);
	assert.deepEqual(limits, []);
});

test("line reader rejects an oversized pending line", () => {
	let limit: { observedBytes: number } | undefined;
	const reader = createLineReader({
		maxBytes: 4,
		onLine: () => assert.fail("must not emit"),
		onLimit: (error) => {
			limit = error;
		},
	});
	reader.push("12345");
	assert.equal(reader.exceeded(), true);
	assert.equal(limit?.observedBytes, 5);
});

test("byte tail and UTF-8 truncation stay bounded", () => {
	const tail = createByteTail(5);
	tail.push("abc");
	tail.push("déf");
	assert.ok(Buffer.byteLength(tail.text()) <= 5);
	const truncated = truncateUtf8("abc😀def", 5);
	assert.equal(truncated.truncated, true);
	assert.match(truncated.text, /^abc/);
	assert.doesNotMatch(truncated.text, /�/);
});
