/**
 * A permission reply that comes back "no such request" is not a failure to
 * show: the ask is gone because something else answered it (galopin answers a
 * subagent's ask its root's mode allows, another client may have clicked
 * first) or its backend restarted. The card settles with a short note instead
 * of opencode's raw error.
 */
export const ALREADY_ANSWERED_NOTE = "Already answered";

export function isAlreadyAnswered(err: unknown): boolean {
	const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
	return /PermissionNotFoundError|no longer pending/i.test(message);
}

/** The outcome of a reply attempt, for a card's `onanswer`. */
export function replyOutcome(err: unknown, fallback: string) {
	if (isAlreadyAnswered(err)) return { ok: true as const, note: ALREADY_ANSWERED_NOTE };
	return { ok: false as const, error: err instanceof Error ? err.message : fallback };
}
