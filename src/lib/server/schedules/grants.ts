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
/** The IdP answered `invalid_grant`: the grant is over. */
export class GrantRefusedError extends Error {
	constructor() {
		super(SIGN_IN_AGAIN);
		this.name = "GrantRefusedError";
	}
}
const DEFAULT_LEEWAY_MS = 60_000;

function oidcSettings() {
	return { redirectURI: `${config.PUBLIC_ORIGIN}${base}/login/callback` };
}
function oidcUrl(): URL {
	return new URL(config.PUBLIC_ORIGIN || "http://localhost");
}

export async function hasGrant(userId: ObjectId): Promise<boolean> {
	return (await collections.scheduleGrants.countDocuments({ userId })) > 0;
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
	await withUserLock(userId, async () => {
		await collections.scheduleGrants.updateOne(
			{ userId },
			{
				$set: {
					refreshSealed: seal(tokens.refresh_token as string),
					issuedAt: now,
					...(options.sub ? { sub: options.sub } : {}),
					...(tokens.access_token
						? {
								accessSealed: seal(tokens.access_token),
								accessExpiresAt: tokens.expires_at
									? new Date(tokens.expires_at * 1000)
									: new Date(now.getTime() + 5 * 60_000),
							}
						: {}),
					...(tokens.scope ? { scope: tokens.scope } : {}),
					updatedAt: now,
				},
				...(tokens.access_token ? {} : { $unset: { accessSealed: "", accessExpiresAt: "" } }),
				$setOnInsert: { userId, createdAt: now },
			},
			{ upsert: true }
		);
	});
	return true;
}

async function withUserLock<T>(userId: ObjectId, fn: () => Promise<T>): Promise<T> {
	const key = `schedule.grant.refresh:${userId.toString()}`;
	const deadline = Date.now() + 30_000;
	for (;;) {
		const lock = await acquireLock(key);
		if (lock) {
			try {
				return await fn();
			} finally {
				await releaseLock(key, lock);
			}
		}
		if (Date.now() > deadline)
			throw new Error("Another scheduled run is refreshing the access; try again.");
		await new Promise((r) => setTimeout(r, 150));
	}
}

export interface GrantAccess {
	value: string;
	expiresAt: Date;
}

/**
 * An access token for the person, refreshed from their grant when the cached one has less than
 * `leewayMs` left. Serialised per person, so a browser session and a scheduled run asking at once
 * share one refresh and never present a stale refresh token. Throws `GrantMissingError`,
 * `GrantRefusedError` (the grant is then already dropped and their chat schedules switched off) or
 * an ordinary error for a refresh that failed for any other reason.
 */
export async function accessTokenFor(
	userId: ObjectId,
	options: { now?: Date; leewayMs?: number } = {}
): Promise<GrantAccess> {
	const now = options.now ?? new Date();
	const leewayMs = options.leewayMs ?? DEFAULT_LEEWAY_MS;
	return withUserLock(userId, async () => {
		const grant = await collections.scheduleGrants.findOne({ userId });
		if (!grant) throw new GrantMissingError();
		if (
			grant.accessSealed &&
			grant.accessExpiresAt &&
			grant.accessExpiresAt.getTime() - now.getTime() > leewayMs
		) {
			return { value: open(grant.accessSealed), expiresAt: grant.accessExpiresAt };
		}
		let tokens: TokenSet | null;
		try {
			tokens = await (
				await oidc()
			).refreshOAuthToken(oidcSettings(), open(grant.refreshSealed), oidcUrl());
		} catch (err) {
			if ((err as { error?: string })?.error === "invalid_grant") {
				await dropGrantAndDisable(userId, SIGN_IN_AGAIN);
				throw new GrantRefusedError();
			}
			throw err;
		}
		if (!tokens?.access_token) throw new Error("The identity provider returned no access token.");
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
					updatedAt: new Date(),
				},
			}
		);
		if (written.matchedCount === 0) {
			logger.warn({ userId: userId.toString() }, "schedule_grant_changed_during_refresh");
		}
		return { value: tokens.access_token, expiresAt: accessExpiresAt };
	});
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
