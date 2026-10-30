/**
 * The background grant: the one per-person OIDC refresh token behind both browser sessions and
 * scheduled chat runs.
 *
 * Every successful login writes it (`saveGrant`: the newest login's token replaces the older), and
 * no session keeps a refresh token of its own any more. IdPs rotate refresh tokens, so a copy per
 * session would go stale the first time any other holder refreshed; instead **everything that needs
 * a fresh access token asks `accessTokenFor`**, which serialises per person (a database lock), saves
 * the rotated refresh token and caches the current access token and its expiry for reuse by every
 * session and run. A run calls the gateway with that access token, so identity, quota, redaction and
 * billing are the person's own.
 *
 * A refresh the IdP refuses (`invalid_grant`) means the grant is over: it is dropped and the person's
 * chat schedules switch off ("Sign in again and turn it back on"); the next login writes a new grant,
 * and the schedules stay off until the person turns them back on. A refresh that fails for any other
 * reason (the IdP unreachable) is an ordinary error. An IdP that issues no refresh token leaves no
 * grant: chat behaves as it always did, and schedules explain what the administrator must allow.
 */

import type { TokenSet } from "openid-client";
import type { ObjectId } from "mongodb";
import { base } from "$app/paths";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { acquireLock, releaseLock } from "$lib/migrations/lock";
import { open, seal, sealingAvailable } from "$lib/server/mcp/secretBox";

// `auth.ts` reaches this module (through the identity code) and this one needs auth's OIDC client:
// loaded when used, so neither is half-initialised for the other.
const oidc = () => import("$lib/server/auth");

export const SIGN_IN_AGAIN =
	"Sign in again and turn it back on: the background access this schedule runs with stopped working.";
export const NEEDS_GRANT =
	"Scheduled chats need background access, which comes from signing in. Sign in again; if this stays, " +
	"your administrator has to allow refresh tokens (the offline_access scope) for the chat's client.";

/** The grant is missing: nothing to refresh. */
export class GrantMissingError extends Error {
	constructor() {
		super(NEEDS_GRANT);
		this.name = "GrantMissingError";
	}
}
/** Another refresh of the same grant is still in flight: not the grant's fault, try again. */
export class GrantBusyError extends Error {
	constructor() {
		super("Another refresh of the background access is in progress; try again.");
		this.name = "GrantBusyError";
	}
}
/** The IdP refused the grant (an OAuth error response), or it is not this person's: the grant is over. */
export class GrantRefusedError extends Error {
	constructor() {
		super(SIGN_IN_AGAIN);
		this.name = "GrantRefusedError";
	}
}
const DEFAULT_LEEWAY_MS = 60_000;
/** The longest a session request waits for another refresh in flight before keeping the token it has. */
export const SESSION_LOCK_WAIT_MS = 3_000;
const RUN_LOCK_WAIT_MS = 30_000;

/** `base`, but never more than half the token's lifetime: a short-lived token must not be refreshed on every request. */
export function leewayFor(baseMs: number, lifetimeMs: number | undefined): number {
	return lifetimeMs && lifetimeMs > 0 ? Math.min(baseMs, Math.floor(lifetimeMs / 2)) : baseMs;
}

/** An OAuth error response from the token endpoint (`invalid_grant`, `server_error` from a revoked chain, ...), as opposed to the endpoint being unreachable. */
function isOAuthErrorResponse(err: unknown): boolean {
	const e = err as { name?: string; error?: unknown } | null;
	return e?.name === "OPError" || typeof e?.error === "string";
}

function oidcSettings() {
	return { redirectURI: `${config.PUBLIC_ORIGIN}${base}/login/callback` };
}
function oidcUrl(): URL {
	return new URL(config.PUBLIC_ORIGIN || "http://localhost");
}

/** Whether there is a grant at all: the sessions' refresh credential, used or not by schedules. */
export async function hasGrant(userId: ObjectId): Promise<boolean> {
	return (await collections.scheduleGrants.countDocuments({ userId })) > 0;
}

/** Whether scheduled chats may use the person's grant right now. */
export async function scheduleGrantUsable(userId: ObjectId): Promise<boolean> {
	return (
		(await collections.scheduleGrants.countDocuments({ userId, scheduleUse: { $ne: false } })) > 0
	);
}

/** Stop scheduled chats using the grant. The token stays: sessions refresh through it. */
export async function stopScheduleUse(userId: ObjectId): Promise<boolean> {
	const { modifiedCount } = await collections.scheduleGrants.updateOne(
		{ userId },
		{ $set: { scheduleUse: false, updatedAt: new Date() } }
	);
	return modifiedCount > 0;
}

/** Let scheduled chats use the grant again (a new login does this itself, as does turning a chat schedule on). Returns false when there is no grant. */
export async function enableScheduleUse(userId: ObjectId): Promise<boolean> {
	const { matchedCount } = await collections.scheduleGrants.updateOne(
		{ userId },
		{ $set: { scheduleUse: true, updatedAt: new Date() } }
	);
	return matchedCount > 0;
}

/**
 * Keep the tokens a login produced, replacing the older grant. Returns false when there is nothing to
 * keep (the IdP issued no refresh token) or it cannot be kept safely (no `CHAT_SECRET_KEY`): the
 * login then goes on as it always did.
 */
export async function saveGrant(
	userId: ObjectId,
	tokens: TokenSet,
	options: { sub?: string } = {}
): Promise<boolean> {
	if (!tokens.refresh_token) return false;
	if (!sealingAvailable()) {
		logger.warn("schedule_grant_not_kept: CHAT_SECRET_KEY is not set");
		return false;
	}
	const now = new Date();
	const expiresAt = tokens.expires_at
		? new Date(tokens.expires_at * 1000)
		: new Date(now.getTime() + 5 * 60_000);
	let replaced: string | undefined;
	await withUserLock(userId, async () => {
		replaced = (await collections.scheduleGrants.findOne({ userId }))?.refreshSealed;
		await collections.scheduleGrants.updateOne(
			{ userId },
			{
				$set: {
					refreshSealed: seal(tokens.refresh_token as string),
					issuedAt: now,
					// A login gives scheduled chats the grant again.
					scheduleUse: true,
					...(options.sub ? { sub: options.sub } : {}),
					...(tokens.access_token
						? {
								accessSealed: seal(tokens.access_token),
								accessExpiresAt: expiresAt,
								accessLifetimeMs: Math.max(0, expiresAt.getTime() - now.getTime()),
							}
						: {}),
					...(tokens.scope ? { scope: tokens.scope } : {}),
					updatedAt: now,
				},
				...(tokens.access_token
					? {}
					: { $unset: { accessSealed: "", accessExpiresAt: "", accessLifetimeMs: "" } }),
				$setOnInsert: { userId, createdAt: now },
			},
			{ upsert: true }
		);
	});
	// The older chain is no use to anyone now: every session refreshes through this one. Revoking it
	// kills its access token at once, so first move the person's other sessions onto the new one.
	if (replaced && tokens.access_token) {
		await collections.sessions
			.updateMany(
				{ userId, "oauth.token": { $exists: true } },
				{
					$set: {
						"oauth.token": {
							value: tokens.access_token,
							expiresAt: new Date(expiresAt.getTime() - 60_000),
						},
					},
				}
			)
			.catch((err) => logger.warn({ err }, "schedule_grant_session_move_failed"));
		try {
			await (await oidc()).revokeOAuthToken(oidcSettings(), open(replaced), oidcUrl());
		} catch (err) {
			logger.info({ err }, "schedule_grant_revoke_replaced_failed");
		}
	}
	return true;
}

async function withUserLock<T>(
	userId: ObjectId,
	fn: () => Promise<T>,
	waitMs = RUN_LOCK_WAIT_MS
): Promise<T> {
	const key = `schedule.grant.refresh:${userId.toString()}`;
	const deadline = Date.now() + waitMs;
	for (;;) {
		const lock = await acquireLock(key);
		if (lock) {
			try {
				return await fn();
			} finally {
				await releaseLock(key, lock);
			}
		}
		if (Date.now() > deadline) throw new GrantBusyError();
		await new Promise((r) => setTimeout(r, 150));
	}
}

export interface GrantAccess {
	value: string;
	expiresAt: Date;
}

/**
 * An access token for the person, refreshed from their grant when the cached one has less than
 * `leewayMs` (never more than half its lifetime) left. Serialised per person, so a browser session and
 * a scheduled run asking at once share one refresh and never present a rotated refresh token. Throws
 * `GrantMissingError` (no grant, or `forSchedule` and background access is stopped), `GrantRefusedError`
 * (the IdP answered the refresh with an OAuth error, or the subject changed: the grant is then already
 * dropped and their chat schedules switched off), `GrantBusyError` (another refresh holds the lock) or
 * an ordinary error for a refresh that could not reach the IdP.
 */
export async function accessTokenFor(
	userId: ObjectId,
	options: { now?: Date; leewayMs?: number; forSchedule?: boolean; lockWaitMs?: number } = {}
): Promise<GrantAccess> {
	const now = options.now ?? new Date();
	const baseLeeway = options.leewayMs ?? DEFAULT_LEEWAY_MS;
	return withUserLock(
		userId,
		async () => {
			const grant = await collections.scheduleGrants.findOne({ userId });
			if (!grant || (options.forSchedule && grant.scheduleUse === false)) {
				throw new GrantMissingError();
			}
			if (
				grant.accessSealed &&
				grant.accessExpiresAt &&
				grant.accessExpiresAt.getTime() - now.getTime() >
					leewayFor(baseLeeway, grant.accessLifetimeMs)
			) {
				return { value: open(grant.accessSealed), expiresAt: grant.accessExpiresAt };
			}
			let tokens: TokenSet | null;
			try {
				tokens = await (
					await oidc()
				).refreshOAuthToken(oidcSettings(), open(grant.refreshSealed), oidcUrl());
			} catch (err) {
				// An OAuth error response means the chain is dead: `invalid_grant`, or the `server_error`
				// an IdP answers for the newest token of a chain it revoked after a rotated token was reused.
				if (isOAuthErrorResponse(err)) {
					await dropGrantAndDisable(userId, SIGN_IN_AGAIN);
					throw new GrantRefusedError();
				}
				throw err;
			}
			if (!tokens?.access_token) throw new Error("The identity provider returned no access token.");
			// A refresh that names a different subject than the login did is not this person's grant.
			if (grant.sub) {
				let sub: string | undefined;
				try {
					sub = tokens.id_token ? tokens.claims().sub : undefined;
				} catch {
					sub = undefined;
				}
				if (sub && sub !== grant.sub) {
					logger.warn({ userId: userId.toString() }, "schedule_grant_subject_mismatch");
					await dropGrantAndDisable(userId, SIGN_IN_AGAIN);
					throw new GrantRefusedError();
				}
			}
			// Rotated when the IdP rotates; kept when it does not. Written only over the token it replaced:
			// a login that landed meanwhile keeps its newer one.
			const refreshSealed = tokens.refresh_token ? seal(tokens.refresh_token) : grant.refreshSealed;
			const accessExpiresAt = tokens.expires_at
				? new Date(tokens.expires_at * 1000)
				: new Date(now.getTime() + 5 * 60_000);
			const written = await collections.scheduleGrants.updateOne(
				{ _id: grant._id, refreshSealed: grant.refreshSealed },
				{
					$set: {
						refreshSealed,
						accessSealed: seal(tokens.access_token),
						accessExpiresAt,
						accessLifetimeMs: Math.max(0, accessExpiresAt.getTime() - now.getTime()),
						updatedAt: new Date(),
					},
				}
			);
			if (written.matchedCount === 0) {
				logger.warn({ userId: userId.toString() }, "schedule_grant_changed_during_refresh");
			}
			return { value: tokens.access_token, expiresAt: accessExpiresAt };
		},
		options.lockWaitMs
	);
}

/** Switch off every chat schedule of the person, with the reason they will read. */
export async function disableChatSchedules(userId: ObjectId, reason: string): Promise<number> {
	const { modifiedCount } = await collections.schedules.updateMany(
		{ userId, kind: "chat", enabled: true },
		{ $set: { enabled: false, nextRunAt: null, disabledReason: reason, updatedAt: new Date() } }
	);
	return modifiedCount;
}

/** Delete the person's grant, asking the IdP to revoke its refresh token first when it can. */
export async function dropGrant(userId: ObjectId): Promise<boolean> {
	const grant = await collections.scheduleGrants.findOneAndDelete({ userId });
	const row = grant?.value;
	if (!row) return false;
	try {
		await (await oidc()).revokeOAuthToken(oidcSettings(), open(row.refreshSealed), oidcUrl());
	} catch (err) {
		logger.info({ err }, "schedule_grant_revoke_failed");
	}
	return true;
}

/** The grant is over: drop it and switch the person's chat schedules off. */
export async function dropGrantAndDisable(userId: ObjectId, reason: string): Promise<void> {
	await dropGrant(userId);
	await disableChatSchedules(userId, reason);
}
