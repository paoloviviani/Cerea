/**
 * Step-up authentication for terminals (ADR 0090 D6): minting a terminal
 * ticket requires the Cerea session's OIDC `auth_time` to be within the
 * last 7 days, otherwise the browser is sent through a fresh login. This
 * limits the "stolen long-lived cookie → shell" case — a terminal ticket
 * cannot be minted from a session cookie alone, however long it has been
 * sitting in a browser profile or a leaked backup.
 *
 * The same window now governs everything under `/api/v2/code/`, not only the
 * terminal ticket: `hooks/handle.ts` refuses every request under that prefix
 * (but `/status`) with `401 {code:"reauth_required"}` while the session is
 * stale, so a route added there later is protected without anyone
 * remembering to. The terminal's own check stays as well, because a
 * WebSocket upgrade never passes through the hook.
 *
 * 7 days (not 12h) since 2026-10: the deployment has no refresh token, so
 * a stolen chat cookie already dies within about an hour — the guard is
 * really aimed at old Authelia remember-me cookies (up to ~1 month), and
 * 7 days stays well under that while asking roughly weekly, not daily.
 *
 * `auth_time` is captured once at login (`routes/login/callback/updateUser.ts`)
 * and never touched by a later access-token refresh, so it tracks the
 * person's actual last authentication, not the session's age.
 */
import { collections } from "$lib/server/database";

export const STEP_UP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The pure rule, for a caller that already holds the session's `authTime`
 * (the hook reads it off the session document `authenticateRequest` loaded:
 * no second query). A missing `authTime` is stale, never exempt. */
export function authTimeFresh(authTime: Date | undefined, now: Date = new Date()): boolean {
	if (!authTime) return false;
	return now.getTime() - authTime.getTime() <= STEP_UP_WINDOW_MS;
}

/** When a fresh `authTime` stops being fresh. */
export function freshUntil(authTime: Date): Date {
	return new Date(authTime.getTime() + STEP_UP_WINDOW_MS);
}

/** Whether `sessionId`'s `auth_time` is within the step-up window right
 * now. A session with no `authTime` (a provider that omits the claim, or a
 * session predating this feature) counts as stale — never exempt. */
export async function sessionAuthFresh(
	sessionId: string,
	now: Date = new Date()
): Promise<boolean> {
	const session = await collections.sessions.findOne(
		{ sessionId },
		{ projection: { authTime: 1 } }
	);
	return authTimeFresh(session?.authTime, now);
}
