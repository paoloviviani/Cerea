import { config } from "$lib/server/config";

/** The message a person reads when the model went quiet mid-answer. */
export const STREAM_IDLE_MESSAGE =
	"The model stopped responding, so this answer was stopped. Try again.";

const DEFAULT_IDLE_MS = 300_000;
const MIN_IDLE_MS = 30_000;

/**
 * The longest a model stream may go without sending a chunk, in ms:
 * `CHAT_STREAM_IDLE_TIMEOUT_MS`, at least 30 s, default 5 minutes. Generous on
 * purpose: slow reasoning models are silent for a while before the first chunk.
 */
export function streamIdleTimeoutMs(): number {
	const parsed = parseInt(config.CHAT_STREAM_IDLE_TIMEOUT_MS ?? "", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_IDLE_MS;
	return Math.max(parsed, MIN_IDLE_MS);
}

export class StreamIdleError extends Error {
	constructor() {
		super(STREAM_IDLE_MESSAGE);
		this.name = "StreamIdleError";
	}
}

/**
 * A signal for one model request that the caller can abort on its own (the
 * idle watchdog does), and that also follows the turn's signal (Stop, the
 * turn cap). Pass `signal` to the SDK call and `abort` to `withIdleTimeout`.
 */
export function linkedRequestSignal(parent?: AbortSignal): {
	signal: AbortSignal;
	abort: () => void;
} {
	const own = new AbortController();
	const signal = parent ? AbortSignal.any([parent, own.signal]) : own.signal;
	return { signal, abort: () => own.abort() };
}

/**
 * Passes `source` through untouched, but bounds the gap between chunks
 * (including the wait for the first). When the gap exceeds `timeoutMs` it calls
 * `onIdle` (abort the underlying request) and throws `StreamIdleError`. A
 * stream that stops sending without closing would otherwise be awaited forever.
 */
export async function* withIdleTimeout<T>(
	source: AsyncIterable<T>,
	opts: { timeoutMs?: number; onIdle?: () => void } = {}
): AsyncGenerator<T, void, undefined> {
	const timeoutMs = opts.timeoutMs ?? streamIdleTimeoutMs();
	const iterator = source[Symbol.asyncIterator]();
	let finished = false;
	try {
		for (;;) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const idle = new Promise<"idle">((resolve) => {
				timer = setTimeout(() => resolve("idle"), timeoutMs);
			});
			const next = iterator.next();
			// The losing promise may reject later (the abort); keep it from surfacing.
			next.catch(() => {});
			let result: IteratorResult<T> | "idle";
			try {
				result = await Promise.race([next, idle]);
			} finally {
				clearTimeout(timer);
			}
			if (result === "idle") {
				finished = true;
				opts.onIdle?.();
				void Promise.resolve(iterator.return?.()).catch(() => {});
				throw new StreamIdleError();
			}
			if (result.done) {
				finished = true;
				return;
			}
			yield result.value;
		}
	} finally {
		if (!finished) await iterator.return?.();
	}
}
