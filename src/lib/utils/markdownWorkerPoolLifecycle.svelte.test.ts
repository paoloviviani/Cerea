import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * A worker the test drives by hand: it records what the pool posts and terminations, and
 * the test decides when it announces readiness or replies.
 */
type FakeWorkerHandle = {
	posted: Array<{ requestId: number }>;
	terminated: number;
	emit(data: unknown): void;
};
const workers = vi.hoisted(() => [] as FakeWorkerHandle[]);

vi.mock("$lib/workers/markdownWorker?worker", () => ({
	default: class FakeWorker {
		onmessage: ((event: MessageEvent) => void) | null = null;
		onerror: ((event: Event) => void) | null = null;
		onmessageerror: ((event: MessageEvent) => void) | null = null;
		posted: Array<{ requestId: number }> = [];
		terminated = 0;
		constructor() {
			workers.push(this);
		}
		postMessage(message: { requestId: number }) {
			this.posted.push(message);
		}
		terminate() {
			this.terminated++;
		}
		emit(data: unknown) {
			this.onmessage?.({ data } as MessageEvent);
		}
	},
}));

const { acquireMarkdownClientId, renderMarkdownBlocks, cancelMarkdownClient, markdownPoolReady } =
	await import("./markdownWorkerPool");

describe("markdownWorkerPool lifecycle", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("markdownPoolReady waits for the worker's ready message, not for a duration", async () => {
		let ready = false;
		void markdownPoolReady().then(() => (ready = true));
		await vi.advanceTimersByTimeAsync(60_000);
		expect(ready).toBe(false);
		workers[0].emit({ type: "ready" });
		await vi.advanceTimersByTimeAsync(0);
		expect(ready).toBe(true);
	});

	it("keeps a booted worker when its client goes away, instead of terminating it", async () => {
		const worker = workers[0];
		const client = acquireMarkdownClientId();
		const onResult = vi.fn();
		const requestId = renderMarkdownBlocks(client, "hello", [], false, onResult);
		expect(worker.posted.map((m) => m.requestId)).toEqual([requestId]);

		cancelMarkdownClient(client);
		// The obsolete parse is quick: the reply returns the worker to the pool warm, and its
		// result is dropped.
		expect(worker.terminated).toBe(0);
		worker.emit({ type: "processed", blocks: [], requestId });
		await vi.advanceTimersByTimeAsync(5_000);
		expect(worker.terminated).toBe(0);
		expect(onResult).not.toHaveBeenCalled();

		// The next view reuses the same worker rather than booting another.
		renderMarkdownBlocks(acquireMarkdownClientId(), "again", [], false, vi.fn());
		expect(workers).toHaveLength(1);
		expect(worker.posted).toHaveLength(2);
	});

	it("still terminates a cancelled job that never finishes", async () => {
		const client = acquireMarkdownClientId();
		const before = workers.map((w) => w.posted.length);
		const requestId = renderMarkdownBlocks(client, "huge", [], false, vi.fn());
		const stuck = workers.find(
			(w, i) => w.posted.length > (before[i] ?? 0) && w.posted.at(-1)?.requestId === requestId
		);
		if (!stuck) throw new Error("no worker received the job");
		cancelMarkdownClient(client);
		expect(stuck.terminated).toBe(0);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(stuck.terminated).toBe(1);
	});
});
