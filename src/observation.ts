export interface ObservationOptions<T> {
	timeoutMs?: number;
	onTimeout?: () => T;
	signal?: AbortSignal;
	abortMessage: string;
}

/**
 * Observe already-started work without cancelling it when the observation
 * window expires or the caller aborts. Timers and abort listeners are always
 * released when the observation settles.
 */
export function observe<T>(
	operation: Promise<T>,
	options: ObservationOptions<T>,
): Promise<T> {
	const { timeoutMs, onTimeout, signal, abortMessage } = options;
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const succeed = (value: T) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const abort = () => fail(signal?.reason ?? new Error(abortMessage));

		operation.then(succeed, fail);
		if (timeoutMs !== undefined && onTimeout) {
			timer = setTimeout(() => succeed(onTimeout()), timeoutMs);
			timer.unref?.();
		}
		if (signal?.aborted) abort();
		else signal?.addEventListener("abort", abort, { once: true });
	});
}
