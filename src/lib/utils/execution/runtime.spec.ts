import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { ExecutionError, ExecutionSession, type ExecutionWorkerLike } from "./runtime";
import {
	MAX_FILE_BYTES,
	MAX_OUTPUT_CHARS,
	safeMountName,
	clampOutput,
	type HostToWorker,
	type WorkerToHost,
} from "./protocol";

/**
 * A scripted stand-in for the execution worker. Tests push replies the way
 * the real worker would, and can simply never reply to exercise the timeout
 * and terminate paths.
 */
class FakeWorker implements ExecutionWorkerLike {
	listeners = { message: [] as ((event: MessageEvent<WorkerToHost>) => void)[], error: [] };
	terminated = 0;
	received: Array<HostToWorker & { id?: number }> = [];

	addEventListener(type: "message", listener: (event: MessageEvent<WorkerToHost>) => void): void;
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	addEventListener(type: "message" | "error", listener: unknown): void {
		if (type === "message") {
			this.listeners.message.push(listener as (event: MessageEvent<WorkerToHost>) => void);
		} else {
			this.listeners.error.push(listener);
		}
	}

	postMessage(message: HostToWorker): void {
		this.received.push(message as HostToWorker & { id?: number });
	}

	terminate(): void {
		this.terminated += 1;
	}

	emit(message: WorkerToHost): void {
		for (const listener of this.listeners.message) {
			listener({ data: message } as MessageEvent<WorkerToHost>);
		}
	}

	fail(): void {
		for (const listener of this.listeners.error) {
			listener(new Error("worker crashed") as ErrorEvent);
		}
	}
}

describe("ExecutionSession", () => {
	let worker: FakeWorker;
	// Requests are dispatched from the queue chain, i.e. one microtask after
	// `run()` returns; tests flush that before touching the fake worker.
	const flush = () => vi.advanceTimersByTimeAsync(0);

	beforeEach(() => {
		vi.useFakeTimers();
		worker = new FakeWorker();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	const spawn = () => worker;

	it("returns the run outcome the worker reported", async () => {
		const session = new ExecutionSession({ spawn });
		const promise = session.run("print('hi')");
		await flush();
		const sent = worker.received[0];
		worker.emit({
			type: "result",
			id: sent?.id ?? -1,
			ok: true,
			stdout: "hi\n",
			stderr: "",
			result: "None",
		});
		await expect(promise).resolves.toEqual({
			ok: true,
			stdout: "hi\n",
			stderr: "",
			result: "None",
			error: undefined,
		});
	});

	it("serializes concurrent runs onto the worker", async () => {
		const session = new ExecutionSession({ spawn });
		const first = session.run("a");
		const second = session.run("b");
		await flush();
		// Both are queued; only the first was posted to the worker so far.
		expect(worker.received).toHaveLength(1);
		worker.emit({
			type: "result",
			id: worker.received[0]?.id ?? -1,
			ok: true,
			stdout: "",
			stderr: "",
		});
		await first;
		await flush();
		expect(worker.received).toHaveLength(2);
		worker.emit({
			type: "result",
			id: worker.received[1]?.id ?? -1,
			ok: true,
			stdout: "",
			stderr: "",
		});
		await expect(second).resolves.toMatchObject({ ok: true });
	});

	it("terminates the worker and rejects when a run exceeds its budget", async () => {
		const session = new ExecutionSession({ spawn, runTimeoutMs: 5_000, loadTimeoutMs: 5_000 });
		const promise = session.run("while True: pass");
		await flush();
		expect(worker.received).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(5_001);
		await expect(promise).rejects.toMatchObject({ kind: "timeout" });
		expect(worker.terminated).toBe(1);
	});

	it("reschedules queued runs onto the fresh worker after a timeout", async () => {
		const session = new ExecutionSession({
			spawn,
			runTimeoutMs: 5_000,
			loadTimeoutMs: 5_000,
		});
		const runaway = session.run("while True: pass");
		const queued = session.run("1 + 1");
		await flush();
		await vi.advanceTimersByTimeAsync(5_001);
		await expect(runaway).rejects.toMatchObject({ kind: "timeout" });
		// The second run was posted to a respawned worker (same fake in tests).
		expect(worker.received.length).toBeGreaterThanOrEqual(2);
		worker.emit({
			type: "result",
			id: worker.received[worker.received.length - 1]?.id ?? -1,
			ok: true,
			stdout: "",
			stderr: "",
		});
		await expect(queued).resolves.toMatchObject({ ok: true });
	});

	it("fails waiters when the worker errors and marks itself unloaded", async () => {
		const session = new ExecutionSession({ spawn });
		const statuses: string[] = [];
		session.onStatus((status) => statuses.push(status));
		const promise = session.run("x");
		await flush();
		worker.fail();
		await expect(promise).rejects.toMatchObject({ kind: "terminated" });
		expect(session.status).toBe("unloaded");
	});

	it("refuses oversized files before anything leaves the page", async () => {
		const session = new ExecutionSession({ spawn });
		const oversized = new ArrayBuffer(MAX_FILE_BYTES + 1);
		await expect(session.loadFiles([{ name: "big.csv", data: oversized }])).rejects.toMatchObject({
			kind: "invalid",
		});
		await flush();
		expect(worker.received).toHaveLength(0);
	});

	it("sends loadFiles within the cap and resolves with written paths", async () => {
		const session = new ExecutionSession({ spawn });
		const promise = session.loadFiles([{ name: "data.csv", data: "a,b\n1,2\n" }]);
		await flush();
		const sent = worker.received[0];
		expect(sent?.type).toBe("loadFiles");
		worker.emit({
			type: "filesLoaded",
			id: sent?.id ?? -1,
			written: ["/mnt/data/data.csv"],
		});
		await expect(promise).resolves.toEqual(["/mnt/data/data.csv"]);
	});

	it("gives a cold runtime the load budget instead of the run budget", async () => {
		const session = new ExecutionSession({ spawn, runTimeoutMs: 1_000, loadTimeoutMs: 60_000 });
		const statuses: string[] = [];
		session.onStatus((status) => statuses.push(status));
		const promise = session.run("1");
		await flush();
		worker.emit({ type: "loading" });
		worker.emit({
			type: "result",
			id: worker.received[0]?.id ?? -1,
			ok: true,
			stdout: "",
			stderr: "",
		});
		await expect(promise).resolves.toMatchObject({ ok: true });
		expect(statuses).toContain("loading");
		// The worker never announced ready, so the session still reports loading.
		expect(statuses).not.toContain("ready");
	});

	it("passes a worker's ready announcement through to status listeners", async () => {
		const session = new ExecutionSession({ spawn });
		const statuses: string[] = [];
		session.onStatus((status) => statuses.push(status));
		const promise = session.run("1");
		await flush();
		worker.emit({ type: "ready" });
		worker.emit({
			type: "result",
			id: worker.received[0]?.id ?? -1,
			ok: true,
			stdout: "",
			stderr: "",
		});
		await expect(promise).resolves.toMatchObject({ ok: true });
		expect(session.status).toBe("ready");
		expect(statuses).toContain("ready");
	});

	it("surfaces a load failure as an ExecutionError, not a hang", async () => {
		const session = new ExecutionSession({ spawn });
		const promise = session.run("1");
		await flush();
		worker.emit({ type: "loadError", message: "404 /pyodide/pyodide.mjs" });
		await expect(promise).rejects.toMatchObject({ kind: "load" });
		expect(session.status).toBe("broken");
	});
});

describe("protocol helpers", () => {
	it("reduces mount names to a safe single segment", () => {
		expect(safeMountName("report.csv")).toBe("report.csv");
		expect(safeMountName("../../etc/passwd")).toBe("passwd");
		expect(safeMountName("a/b/c.txt")).toBe("c.txt");
		expect(safeMountName("..")).toBeNull();
		expect(safeMountName("")).toBeNull();
		expect(safeMountName("bad\u0000name")).toBe("badname");
	});

	it("clamps output to the cap including its marker", () => {
		const long = "x".repeat(MAX_OUTPUT_CHARS + 1);
		const clamped = clampOutput(long);
		expect(clamped.length).toBeLessThanOrEqual(MAX_OUTPUT_CHARS);
		expect(clamped.endsWith("[output truncated]")).toBe(true);
		expect(clampOutput("short")).toBe("short");
	});
});

describe("ExecutionError", () => {
	it("carries its kind for UI decisions", () => {
		const error = new ExecutionError("timeout", "took too long");
		expect(error.kind).toBe("timeout");
		expect(error.name).toBe("ExecutionError");
	});
});
