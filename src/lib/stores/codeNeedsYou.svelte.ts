/**
 * What the Needs-you inbox shares with the rest of the app.
 *
 * The inbox itself (`NeedsYouInbox`) owns the polling and the cards; this
 * store carries only two small facts across components that never render
 * each other:
 *
 * - `pending`: which sessions have an ask waiting, published by the
 *   app-wide bar, so the sidebar can badge its Agents option without a
 *   second poll.
 * - claims: sessions whose asks another inbox instance already shows on
 *   this screen (the chat's composer-pinned asks). The app-wide bar leaves
 *   those out, so one question never appears twice.
 */

import { untrack } from "svelte";

export interface SessionRef {
	deviceId: string;
	sessionId: string;
}

export const codeNeedsYou = $state<{
	/** One entry per pending ask (a session with two asks appears twice). */
	pending: SessionRef[];
	/** Claimed sessions, as `${deviceId}:${sessionId}`; counted so two claimers can overlap. */
	claimed: Record<string, number>;
}>({ pending: [], claimed: {} });

export const sessionKey = (ref: SessionRef): string => `${ref.deviceId}:${ref.sessionId}`;

export function publishPending(refs: SessionRef[]): void {
	codeNeedsYou.pending = refs.map(({ deviceId, sessionId }) => ({ deviceId, sessionId }));
}

export function clearPending(): void {
	codeNeedsYou.pending = [];
}

/** Claim sessions for the lifetime of one inbox instance; call the result to release. */
export function claimSessions(refs: SessionRef[]): () => void {
	const keys = refs.map(sessionKey);
	// Read-modify-write: untracked, so a claim made inside an effect does not
	// make that effect depend on the very state it writes.
	untrack(() => {
		for (const key of keys) codeNeedsYou.claimed[key] = (codeNeedsYou.claimed[key] ?? 0) + 1;
	});
	return () =>
		untrack(() => {
			for (const key of keys) {
				const next = (codeNeedsYou.claimed[key] ?? 1) - 1;
				if (next <= 0) delete codeNeedsYou.claimed[key];
				else codeNeedsYou.claimed[key] = next;
			}
		});
}

export function isClaimed(ref: SessionRef): boolean {
	return (codeNeedsYou.claimed[sessionKey(ref)] ?? 0) > 0;
}
