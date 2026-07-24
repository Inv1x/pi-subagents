export interface ScheduleOptions {
	priority: "foreground" | "background";
	signal?: AbortSignal;
	resources?: string[];
	onQueued?: (position: number) => void;
}

interface QueueEntry<T> {
	id: number;
	options: ScheduleOptions;
	work: () => Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: unknown) => void;
	abortListener?: () => void;
}

export class Scheduler {
	private readonly queue: QueueEntry<unknown>[] = [];
	private readonly activeResources = new Set<string>();
	private active = 0;
	private nextId = 1;
	private foregroundBurst = 0;

	constructor(private limit: number) {}

	setLimit(limit: number): void {
		this.limit = Math.max(1, Math.floor(limit));
		this.drain();
	}

	get activeCount(): number {
		return this.active;
	}

	get queuedCount(): number {
		return this.queue.length;
	}

	run<T>(work: () => Promise<T>, options: ScheduleOptions): Promise<T> {
		if (options.signal?.aborted)
			return Promise.reject(options.signal.reason ?? new Error("Cancelled"));
		return new Promise<T>((resolve, reject) => {
			const entry: QueueEntry<T> = {
				id: this.nextId++,
				work,
				options: {
					...options,
					resources: [...new Set(options.resources ?? [])].sort(),
				},
				resolve,
				reject,
			};
			if (options.signal) {
				entry.abortListener = () => {
					const index = this.queue.indexOf(entry as QueueEntry<unknown>);
					if (index < 0) return;
					this.queue.splice(index, 1);
					reject(options.signal?.reason ?? new Error("Cancelled while queued"));
					this.notifyQueuePositions();
				};
				options.signal.addEventListener("abort", entry.abortListener, {
					once: true,
				});
			}
			this.queue.push(entry as QueueEntry<unknown>);
			this.sortQueue();
			this.notifyQueuePositions();
			this.drain();
		});
	}

	private sortQueue(): void {
		this.queue.sort((a, b) => {
			const priorityA = a.options.priority === "foreground" ? 0 : 1;
			const priorityB = b.options.priority === "foreground" ? 0 : 1;
			return priorityA - priorityB || a.id - b.id;
		});
	}

	private canStart(entry: QueueEntry<unknown>): boolean {
		return (entry.options.resources ?? []).every(
			(resource) => !this.activeResources.has(resource),
		);
	}

	private notifyQueuePositions(): void {
		this.queue.forEach((entry, index) => {
			entry.options.onQueued?.(index + 1);
		});
	}

	private drain(): void {
		while (this.active < this.limit && this.queue.length > 0) {
			const firstRunnable = this.queue.findIndex((entry) =>
				this.canStart(entry),
			);
			if (firstRunnable < 0) return;
			const runnableBackground = this.queue.findIndex(
				(entry) =>
					entry.options.priority === "background" && this.canStart(entry),
			);
			const index =
				this.foregroundBurst >= 8 && runnableBackground >= 0
					? runnableBackground
					: firstRunnable;
			const entry = this.queue.splice(index, 1)[0];
			if (!entry) return;
			if (entry.options.priority === "background") this.foregroundBurst = 0;
			else this.foregroundBurst++;
			if (entry.abortListener && entry.options.signal) {
				entry.options.signal.removeEventListener("abort", entry.abortListener);
			}
			for (const resource of entry.options.resources ?? [])
				this.activeResources.add(resource);
			this.active++;
			this.notifyQueuePositions();
			void entry
				.work()
				.then(entry.resolve, entry.reject)
				.finally(() => {
					for (const resource of entry.options.resources ?? [])
						this.activeResources.delete(resource);
					this.active--;
					this.drain();
				});
		}
	}
}
