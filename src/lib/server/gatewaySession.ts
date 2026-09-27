/**
 * The gateway's word on a signed-in session, cached briefly (ADR 0093 §4.4).
 *
 * On a gateway preset (`OPENAI_BASE_URL` set, `USE_USER_TOKEN=true`) the
 * gateway is the only authorisation authority: whether someone is an
 * administrator, whether their account is active at all, and whether their
 * identity has moved onto someone else's. Each session asks `GET /v1/me`
 * with its own access token, at most once a minute (`TTL_MS`). The answer
 * decides one of four outcomes:
 *
 * - **`ended`**: a 401 (the token or the account is refused); the gateway's
 *   `id` differs from the session user's `gatewayUserId` (their identity was
 *   merged into someone else, elsewhere — the next login resolves through
 *   `gatewayLogin.ts`'s `resolveGatewayLogin`); or `sessions_valid_after` is
 *   newer than the session's own `createdAt` (an admin action — a disable, a
 *   sessions-revoke — postdates this login). The caller deletes the session.
 * - **`valid`**: the session stands, with the gateway's current `is_admin`
 *   and `groups`. If `merged_at` is newer than the chat user's own
 *   `lastMergeSyncAt`, this also launches a **background** fold: `GET
 *   /v1/me/identities`, then `mergeChatUsers` (via `gatewayLogin.ts`'s
 *   `findStrays`/`mergeStrays`) for every stray it names, then
 *   `lastMergeSyncAt` is stamped to the gateway's own `merged_at` — so a
 *   merge converges within a minute of the target's next activity, not at
 *   their next login, and a stable `merged_at` never re-fetches identities
 *   on every subsequent check. Not awaited: the request that triggered the
 *   check does not wait on it.
 * - **`open`**: the gateway could not be reached (a network error or a 5xx)
 *   but answered within the last five minutes (`FAIL_OPEN_GRACE_MS`) — an
 *   outage this short must not end every session on the box. The caller
 *   proceeds exactly as it would with no gateway to ask at all.
 * - **`unavailable`**: unreachable for more than five minutes straight. The
 *   caller answers 503 ("can't verify your account; the gateway is
 *   unreachable") rather than guessing either way, and — unlike `ended` —
 *   the session is *not* deleted, so it resumes on its own once the gateway
 *   answers again.
 *
 * `null` means the check does not apply at all: no gateway, a shared
 * deployment key (the generic preset), or no token to ask with.
 */
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { identities, me, type GatewayIdentityOptions } from "./identity/gatewayIdentity";
import { findStrays, mergeStrays } from "./identity/gatewayLogin";
import type { ObjectId } from "mongodb";

export type GatewaySessionOutcome =
	| { kind: "valid"; isAdmin: boolean; groups: string[] }
	| { kind: "ended" }
	| { kind: "open" }
	| { kind: "unavailable" };

const TTL_MS = 60_000;
const FAIL_OPEN_GRACE_MS = 5 * 60_000;
const MAX_ENTRIES = 5_000;

const cache = new Map<string, { at: number; outcome: GatewaySessionOutcome }>();
/** The last time each session got *any* answer from the gateway (refused,
 * ended-by-mismatch or valid — anything but a network error/5xx), for the
 * bounded fail-open. */
const lastGoodAnswerAt = new Map<string, number>();

export interface GatewaySessionOptions {
	baseUrl?: string;
	userToken?: boolean;
	fetchImpl?: typeof fetch;
	now?: () => number;
}

/** `GET /v1/me/identities` plus the merge, off the request path. Errors are
 * logged and swallowed: a failed fold here is retried on the very next
 * check that sees the same (or a newer) `merged_at`. */
async function foldMergedIdentities(
	targetId: ObjectId,
	token: string,
	options: GatewayIdentityOptions,
	mergedAt: Date
): Promise<void> {
	const result = await identities(token, options);
	if (!result.ok) return;
	const strays = await findStrays(
		collections.users,
		result.value.merged_from,
		result.value.identities
	);
	await mergeStrays(strays, targetId);
	await collections.users.updateOne({ _id: targetId }, { $set: { lastMergeSyncAt: mergedAt } });
}

export async function gatewaySessionCheck(
	sessionId: string,
	token: string,
	options: GatewaySessionOptions = {}
): Promise<GatewaySessionOutcome | null> {
	const baseUrl = (options.baseUrl ?? config.OPENAI_BASE_URL ?? "").replace(/\/$/, "");
	const userToken = options.userToken ?? config.USE_USER_TOKEN === "true";
	// No gateway, or a shared deployment key (the generic preset): there is
	// nobody to ask about this person.
	if (!baseUrl || !userToken || !token) return null;
	const now = (options.now ?? Date.now)();
	const hit = cache.get(sessionId);
	if (hit && now - hit.at < TTL_MS) return hit.outcome;

	const gwOptions: GatewayIdentityOptions = { baseUrl, fetchImpl: options.fetchImpl };
	const result = await me(token, gwOptions);

	let outcome: GatewaySessionOutcome;
	if (!result.ok && !result.refused) {
		// Network error or 5xx: bounded fail-open.
		const lastGood = lastGoodAnswerAt.get(sessionId);
		outcome =
			lastGood !== undefined && now - lastGood < FAIL_OPEN_GRACE_MS
				? { kind: "open" }
				: { kind: "unavailable" };
	} else if (!result.ok) {
		// 401/403: refused outright.
		lastGoodAnswerAt.set(sessionId, now);
		outcome = { kind: "ended" };
	} else {
		lastGoodAnswerAt.set(sessionId, now);
		const body = result.value;
		const session = await collections.sessions.findOne({ sessionId });
		const user = session ? await collections.users.findOne({ _id: session.userId }) : null;
		// A user who hasn't logged in since this app started resolving through
		// the gateway carries no `gatewayUserId` yet: nothing to compare, so no
		// mismatch — the next login (`gatewayLogin.ts`) is what backfills it.
		const idMismatch = user?.gatewayUserId !== undefined && user.gatewayUserId !== body.id;
		const validAfter = body.sessions_valid_after ? new Date(body.sessions_valid_after) : null;
		const sessionStale = Boolean(
			session && validAfter && validAfter.getTime() > session.createdAt.getTime()
		);
		if (!session || idMismatch || sessionStale) {
			outcome = { kind: "ended" };
		} else {
			outcome = {
				kind: "valid",
				isAdmin: body.is_admin === true,
				groups: Array.isArray(body.groups) ? body.groups.map(String) : [],
			};
			if (user && body.merged_at) {
				const mergedAt = new Date(body.merged_at);
				if (!user.lastMergeSyncAt || mergedAt.getTime() > user.lastMergeSyncAt.getTime()) {
					foldMergedIdentities(user._id, token, gwOptions, mergedAt).catch((err) =>
						logger.warn({ err }, "gateway_session_fold_failed")
					);
				}
			}
		}
	}

	if (cache.size >= MAX_ENTRIES) cache.clear();
	cache.set(sessionId, { at: now, outcome });
	return outcome;
}

export function forgetGatewaySession(sessionId: string): void {
	cache.delete(sessionId);
	lastGoodAnswerAt.delete(sessionId);
}
