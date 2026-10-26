import { config } from "$lib/server/config";

const DEFAULT_TURN_MAX_MINUTES = 30;
const MIN_TURN_MAX_MINUTES = 1;

/** Why a turn was aborted by the server's own cap rather than by the person's Stop. */
export class TurnTimeoutError extends Error {
	readonly minutes: number;
	constructor(minutes: number) {
		super(`This answer took longer than ${minutes} minutes and was stopped.`);
		this.name = "TurnTimeoutError";
		this.minutes = minutes;
	}
}

/** `CHAT_TURN_MAX_MINUTES`: at least 1, default 30; invalid or empty means the default. */
export function turnMaxMinutes(): number {
	const parsed = parseInt(config.CHAT_TURN_MAX_MINUTES ?? "", 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TURN_MAX_MINUTES;
	return Math.max(parsed, MIN_TURN_MAX_MINUTES);
}

/**
 * Arms the cap on `ctrl`: after the limit it aborts with a `TurnTimeoutError`.
 * Returns the timer to clear where the turn ends. `unref`ed, so it never keeps
 * the process alive.
 */
export function armTurnCap(
	ctrl: AbortController,
	minutes: number = turnMaxMinutes()
): ReturnType<typeof setTimeout> {
	const timer = setTimeout(() => ctrl.abort(new TurnTimeoutError(minutes)), minutes * 60_000);
	timer.unref?.();
	return timer;
}

/**
 * How an aborted turn is classified. The cap is an error (the person did not
 * ask to stop); anything else that aborted is the person's Stop.
 */
export function classifyTurnAbort(
	signal: AbortSignal
): { kind: "timeout"; message: string } | { kind: "user" } {
	return signal.reason instanceof TurnTimeoutError
		? { kind: "timeout", message: signal.reason.message }
		: { kind: "user" };
}

/** How long a capped turn gets to wind down on its own before it is cut loose. */
export const TURN_CAP_GRACE_MS = 15_000;

/**
 * Passes `source` through, but once `signal` is aborted by the cap, stops
 * waiting on it after `graceMs` and throws the `TurnTimeoutError`. Aborting
 * the signal only ends waits that listen to it; something stuck on a wait that
 * does not (whatever hung the turn in the first place) would otherwise keep the
 * turn, and its heartbeat, alive past the cap. A Stop is left to end the turn
 * as before.
 */
export async function* untilCapped<T>(
	source: AsyncIterable<T>,
	signal: AbortSignal,
	graceMs: number = TURN_CAP_GRACE_MS
): AsyncGenerator<T, void, undefined> {
	const iterator = source[Symbol.asyncIterator]();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const capped = new Promise<never>((_, reject) => {
		const onAbort = () => {
			if (!(signal.reason instanceof TurnTimeoutError)) return;
			timer = setTimeout(() => reject(signal.reason), graceMs);
			timer.unref?.();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
	});
	capped.catch(() => {});
	let finished = false;
	try {
		for (;;) {
			const next = iterator.next();
			next.catch(() => {});
			let result: IteratorResult<T>;
			try {
				result = await Promise.race([next, capped]);
			} catch (err) {
				if (err instanceof TurnTimeoutError) {
					finished = true;
					void Promise.resolve(iterator.return?.()).catch(() => {});
				}
				throw err;
			}
			if (result.done) {
				finished = true;
				return;
			}
			yield result.value;
		}
	} finally {
		clearTimeout(timer);
		if (!finished) await iterator.return?.();
	}
}
