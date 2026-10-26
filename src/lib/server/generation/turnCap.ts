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
