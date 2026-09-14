import {
	LOAD_TIMEOUT_MS,
	MAX_FILE_BYTES,
	RUN_TIMEOUT_MS,
	type HostToWorker,
	type RunOutcome,
	type WorkerToHost,
} from "./protocol";

/**
 * Host side of the execution runtime: owns the single worker, serializes
 * requests onto it, and holds the kill switch.
 *
 * The contract that matters: model-written code never runs on the main
 * thread. When a run exceeds its wall-clock budget the worker is terminated
 * outright — wasm has no cooperative cancellation, so the only safe stop is
 * the hard one — and the session is rebuilt lazily on the next request. The
 * timed-out run rejects; anything still queued runs on the fresh worker.
 */

export interface ExecutionWorkerLike {
	postMessage(message: HostToWorker, transfer?: Transferable[]): void;
	addEventListener(type: "message", listener: (event: MessageEvent<WorkerToHost>) => void): void;
	addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
	terminate(): void;
}

export type ExecutionStatus = "unloaded" | "loading" | "ready" | "broken";

export class ExecutionError extends Error {
	kind: "timeout" | "terminated" | "worker" | "invalid" | "load";
	constructor(kind: ExecutionError["kind"], message: string) {
		super(message);
		this.kind = kind;
		this.name = "ExecutionError";
	}
}

interface Pending {
	resolve: (value: WorkerToHost) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

export interface ExecutionSessionOptions {
	spawn?: () => ExecutionWorkerLike;
	loadTimeoutMs?: number;
	runTimeoutMs?: number;
}

export class ExecutionSession {
	private spawnWorker: () => ExecutionWorkerLike;
	private loadTimeoutMs: number;
	private runTimeoutMs: number;
	private worker: ExecutionWorkerLike | null = null;
	private nextId = 1;
	private pending = new Map<number, Pending>();
	private queueTail: Promise<unknown> = Promise.resolve();
	private statusListeners = new Set<(status: ExecutionStatus) => void>();

	status: ExecutionStatus = "unloaded";

	constructor(options: ExecutionSessionOptions = {}) {
		this.spawnWorker =
			options.spawn ??
			(() =>
				new Worker(new URL("./pyodide.worker.ts", import.meta.url), {
					type: "module",
				}) as unknown as ExecutionWorkerLike);
		this.loadTimeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
		this.runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
	}

	onStatus(listener: (status: ExecutionStatus) => void): () => void {
		this.statusListeners.add(listener);
		listener(this.status);
		return () => this.statusListeners.delete(listener);
	}

	/** Execute one snippet. Runs are serialized; `code` is model-written input. */
	run(code: string, timeoutMs = this.runTimeoutMs): Promise<RunOutcome> {
		return this.enqueue(() =>
			this.dispatch(
				{ type: "run", id: this.nextId++, code },
				timeoutMs,
				(m): m is Extract<WorkerToHost, { type: "result" }> => m.type === "result"
			).then((message) => ({
				ok: message.ok,
				stdout: message.stdout,
				stderr: message.stderr,
				result: message.result,
				error: message.error,
			}))
		);
	}

	/**
	 * Write files into the runtime at /mnt/data. The 50 MB cap is enforced
	 * here, before the transfer leaves the page — an oversized file is a named
	 * refusal, not a silent truncation.
	 */
	async loadFiles(
		files: Array<{ name: string; data: ArrayBuffer | string }>,
		timeoutMs = this.runTimeoutMs
	): Promise<string[]> {
		for (const file of files) {
			const size = typeof file.data === "string" ? file.data.length : file.data.byteLength;
			if (size > MAX_FILE_BYTES) {
				throw new ExecutionError(
					"invalid",
					`"${file.name}" is ${(size / (1024 * 1024)).toFixed(1)} MB; the runtime accepts files up to 50 MB`
				);
			}
		}
		const message = await this.enqueue(() =>
			this.dispatch(
				{ type: "loadFiles", id: this.nextId++, files },
				timeoutMs,
				(m): m is Extract<WorkerToHost, { type: "filesLoaded" }> => m.type === "filesLoaded"
			)
		);
		return message.written;
	}

	/** Kill whatever is running and drop the worker; the next request respawns. */
	terminate(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.rejectAllPending(new ExecutionError("terminated", "the execution sandbox was reset"));
		this.setStatus("unloaded");
	}

	/** Idle teardown (e.g. page hidden for a long time) — same as terminate. */
	dispose(): void {
		this.terminate();
		this.statusListeners.clear();
	}

	/** Remove one mounted file from /mnt/data. */
	async removeFile(path: string): Promise<string> {
		const message = await this.enqueue(() =>
			this.dispatch(
				{ type: "removeFile", id: this.nextId++, path },
				this.runTimeoutMs,
				(m): m is Extract<WorkerToHost, { type: "fileRemoved" }> => m.type === "fileRemoved"
			)
		);
		if (message.error) throw new ExecutionError("worker", message.error);
		return message.path;
	}

	private enqueue<T>(job: () => Promise<T>): Promise<T> {
		// A failed predecessor must not poison the queue: every job runs, its
		// result is what rejects. The tail swallows outcomes either way.
		const scheduled = this.queueTail.then(job, job);
		this.queueTail = scheduled.then(
			() => undefined,
			() => undefined
		);
		return scheduled;
	}

	private dispatch<Reply extends WorkerToHost>(
		message: HostToWorker,
		timeoutMs: number,
		matches: (message: WorkerToHost) => message is Reply
	): Promise<Reply> {
		// A cold runtime pays the interpreter load inside the first request's
		// budget, so one long budget covers it instead of two racing ones.
		const budget = this.status === "ready" ? timeoutMs : Math.max(timeoutMs, this.loadTimeoutMs);
		return new Promise<Reply>((resolve, reject) => {
			let worker: ExecutionWorkerLike;
			try {
				worker = this.ensureWorker();
			} catch (err) {
				reject(err);
				return;
			}
			const id = message.id;
			const timer = setTimeout(() => {
				// Reject with the timeout kind first, then kill the worker: the
				// terminate sweep rejects everything still pending, and the request
				// that caused the kill must report "timeout", not "terminated".
				reject(
					new ExecutionError(
						"timeout",
						`the code did not finish within ${Math.round(budget / 1000)} s and was stopped`
					)
				);
				this.terminate();
			}, budget);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					if (matches(value)) resolve(value);
					else reject(new ExecutionError("worker", "unexpected message from the runtime"));
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
				timer,
			});
			worker.postMessage(message);
		});
	}

	private ensureWorker(): ExecutionWorkerLike {
		if (this.worker) return this.worker;
		const worker = this.spawnWorker();
		worker.addEventListener("message", (event: MessageEvent<WorkerToHost>) => {
			const data = event.data;
			if (!data || typeof data !== "object") return;
			if (data.type === "loading") {
				this.setStatus("loading");
				return;
			}
			if (data.type === "ready") {
				this.setStatus("ready");
				return;
			}
			if (data.type === "loadError") {
				this.setStatus("broken");
				// The worker stays up but can never load; fail everything queued.
				this.rejectAllPending(
					new ExecutionError("load", `the Python runtime failed to load: ${data.message}`)
				);
				return;
			}
			const pending = "id" in data ? this.pending.get(data.id) : undefined;
			if (pending) {
				this.pending.delete(data.id);
				pending.resolve(data);
			}
		});
		worker.addEventListener("error", () => {
			// An uncaught error inside the worker (wasm abort, OOM kill) means the
			// interpreter state is untrustworthy: drop it and fail the waiters.
			this.terminate();
		});
		this.worker = worker;
		this.setStatus("loading");
		return worker;
	}

	private rejectAllPending(error: Error): void {
		for (const pending of this.pending.values()) {
			pending.reject(error);
		}
		this.pending.clear();
	}

	private setStatus(status: ExecutionStatus): void {
		this.status = status;
		for (const listener of this.statusListeners) listener(status);
	}
}

let browserSession: ExecutionSession | null = null;

/**
 * The app-wide session, created on first use. Returns undefined during SSR,
 * where workers cannot exist and no code block is interactive anyway.
 */
export function getExecutionSession(): ExecutionSession | undefined {
	if (typeof window === "undefined") return undefined;
	browserSession ??= new ExecutionSession();
	return browserSession;
}
