import { Buffer } from "node:buffer";

export const MAX_JSON_LINE_BYTES = 4 * 1024 * 1024;
export const MAX_STDERR_BYTES = 128 * 1024;

export interface LineLimitError {
	code: "protocol_output_limit";
	limitBytes: number;
	observedBytes: number;
	preview: string;
}

export function createLineReader(options: {
	maxBytes?: number;
	onLine: (line: string) => void;
	onLimit: (error: LineLimitError) => void;
}) {
	const maxBytes = options.maxBytes ?? MAX_JSON_LINE_BYTES;
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	let exceeded = false;

	const append = (chunk: Buffer) => {
		if (exceeded || chunk.length === 0) return;
		const observedBytes = pendingBytes + chunk.length;
		if (observedBytes > maxBytes) {
			exceeded = true;
			const previewParts = [...pending, chunk];
			options.onLimit({
				code: "protocol_output_limit",
				limitBytes: maxBytes,
				observedBytes,
				preview: Buffer.concat(previewParts, Math.min(observedBytes, 2048))
					.subarray(0, 2048)
					.toString("utf8"),
			});
			pending = [];
			pendingBytes = 0;
			return;
		}
		pending.push(chunk);
		pendingBytes = observedBytes;
	};

	const emit = () => {
		if (pendingBytes === 0) return;
		options.onLine(Buffer.concat(pending, pendingBytes).toString("utf8"));
		pending = [];
		pendingBytes = 0;
	};

	return {
		push(chunk: Buffer | string) {
			if (exceeded) return;
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			let start = 0;
			for (let index = 0; index < bytes.length; index++) {
				if (bytes[index] !== 0x0a) continue;
				append(bytes.subarray(start, index));
				if (exceeded) return;
				emit();
				start = index + 1;
			}
			append(bytes.subarray(start));
		},
		end() {
			if (!exceeded) emit();
		},
		exceeded: () => exceeded,
	};
}

export function createByteTail(maxBytes = MAX_STDERR_BYTES) {
	let value = Buffer.alloc(0);
	return {
		push(chunk: Buffer | string) {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
			value = Buffer.concat([value, bytes]);
			if (value.length > maxBytes) {
				let start = value.length - maxBytes;
				while (start < value.length && ((value[start] ?? 0) & 0xc0) === 0x80)
					start++;
				value = value.subarray(start);
			}
		},
		text: () => value.toString("utf8"),
		byteLength: () => value.length,
	};
}

export function truncateUtf8(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean; originalBytes: number } {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes)
		return { text, truncated: false, originalBytes: bytes.length };
	let end = maxBytes;
	while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end--;
	const retained = bytes.subarray(0, end).toString("utf8");
	return {
		text: `${retained}\n\n[Output truncated: ${bytes.length - end} bytes omitted. Full output is available in the run artifact.]`,
		truncated: true,
		originalBytes: bytes.length,
	};
}
