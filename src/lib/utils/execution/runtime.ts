import { m } from "$lib/paraglide/messages";
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
 *
 * Files mounted at /mnt/data are the session's own record (`mounted`): every
 * worker it spawns, the first or a restart after a timeout or crash, is
 * handed all of them before it sees any other request, so a run never starts
 * on a sandbox that is missing the person's attachments.
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
	/** For `timeout`: the limit that was hit, and the /mnt/data paths restored after the restart. */
	timeout?: { seconds: number; mountedFiles: string[] };
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
	/**
	 * Whether PyPI installs are currently allowed — the effective value
	 * (user opt-in AND NOT admin-killed), computed by the caller. Applied to
	 * every worker this session spawns, and re-sent live to an existing one:
	 * a setting toggled mid-conversation must not require a page reload.
	 */
	private pypiEnabled = false;
	/**
	 * Every file currently mounted at /mnt/data, by path, with its bytes. The
	 * worker's filesystem dies with the worker; this is what is written back
	 * into the next one.
	 */
	private mounted = new Map<string, { name: string; data: ArrayBuffer | string }>();

	status: ExecutionStatus = "unloaded";

	constructor(options: ExecutionSessionOptions = {}) {
		this.spawnWorker =
			options.spawn ??
			(() =>
				new Worker(new URL("./pyodide.worker.ts", import.meta.url), {
					type: "module",
				}));
		this.loadTimeoutMs = options.loadTimeoutMs ?? LOAD_TIMEOUT_MS;
		this.runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
	}

	onStatus(listener: (status: ExecutionStatus) => void): () => void {
		this.statusListeners.add(listener);
		listener(this.status);
		return () => this.statusListeners.delete(listener);
	}

	/**
	 * Set whether PyPI installs are currently allowed. Idempotent-safe to call
	 * on every reactive re-evaluation (e.g. a Svelte `$effect`): a live worker
	 * is notified immediately, and a not-yet-spawned one picks the value up
	 * from `ensureWorker` when it starts.
	 */
	configure(pypiEnabled: boolean, runTimeoutMs?: number): void {
		if (runTimeoutMs !== undefined) this.runTimeoutMs = runTimeoutMs;
		this.pypiEnabled = pypiEnabled;
		this.worker?.postMessage({ type: "configure", pypiEnabled });
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
		files.forEach((file, i) => {
			const path = message.written[i];
			if (path) this.mounted.set(path, { name: file.name, data: file.data });
		});
		return message.written;
	}

	/** The /mnt/data paths that will be present on every (re)started worker. */
	mountedPaths(): string[] {
		return [...this.mounted.keys()];
	}

	/** Kill whatever is running and drop the worker; the next request respawns. */
	terminate(): void {
		if (this.worker) {
			this.worker.terminate();
			this.worker = null;
		}
		this.rejectAllPending(new ExecutionError("terminated", m["chat.errors.sandbox_reset"]()));
		this.setStatus("unloaded");
	}

	/** Idle teardown (e.g. page hidden for a long time) — same as terminate. */
	dispose(): void {
		this.terminate();
		this.statusListeners.clear();
	}

	/** Remove one mounted file from /mnt/data. */
	async removeFile(path: string): Promise<string> {
		// Forgotten first: a worker that is down (or dies next) must not get the
		// file back. With no worker alive there is nothing to take it out of, and
		// booting the interpreter just to delete a file would cost a cold start.
		this.mounted.delete(path);
		if (!this.worker) return path;
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

	/**
	 * Files the runtime currently holds in its working directory — what the
	 * last runs generated. Best-effort by design: a listing that fails is an
	 * empty panel, never a failed run.
	 */
	async listFiles(timeoutMs = this.runTimeoutMs): Promise<Array<{ path: string; size: number }>> {
		const message = await this.enqueue(() =>
			this.dispatch(
				{ type: "listFiles", id: this.nextId++ },
				timeoutMs,
				(m): m is Extract<WorkerToHost, { type: "filesListed" }> => m.type === "filesListed"
			)
		);
		return message.files;
	}

	/**
	 * Read one runtime file back out for download. Bytes arrive as a
	 * transferable, never through the capped text output — a .docx is not a
	 * Result string.
	 */
	async readFile(path: string, timeoutMs = this.runTimeoutMs): Promise<ArrayBuffer> {
		const message = await this.enqueue(() =>
			this.dispatch(
				{ type: "readFile", id: this.nextId++, path },
				timeoutMs,
				(m): m is Extract<WorkerToHost, { type: "fileData" }> => m.type === "fileData"
			)
		);
		if (message.error || !message.data) {
			throw new ExecutionError("worker", message.error ?? m["chat.errors.read_failed"]({ path }));
		}
		return message.data;
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
		// "configure" carries no id and is never dispatched through here (it is
		// posted directly, fire-and-forget, from ensureWorker/configure): every
		// message that awaits a reply has one.
		message: Exclude<HostToWorker, { type: "configure" }>,
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
				const seconds = Math.round(budget / 1000);
				const error = new ExecutionError("timeout", m["chat.errors.timeout"]({ seconds }));
				error.timeout = { seconds, mountedFiles: this.mountedPaths() };
				reject(error);
				this.terminate();
			}, budget);
			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					if (matches(value)) resolve(value);
					else reject(new ExecutionError("worker", m["chat.errors.unexpected_message"]()));
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
					new ExecutionError("load", m["chat.errors.runtime_load"]({ message: data.message }))
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
		// Posted synchronously, before dispatch() posts the actual command below
		// it in the same call stack: the worker processes messages in the order
		// received, so this always lands before the first "run"/"loadFiles"/etc.
		worker.postMessage({ type: "configure", pypiEnabled: this.pypiEnabled });
		// A restarted worker comes up empty. Every mounted file is written back
		// before the request that caused this spawn is posted, and the worker
		// handles messages in order, so no run ever sees a half-restored
		// /mnt/data. Nothing waits on the reply (no pending entry; it is ignored).
		for (const file of this.mounted.values()) {
			worker.postMessage({ type: "loadFiles", id: this.nextId++, files: [file] });
		}
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
