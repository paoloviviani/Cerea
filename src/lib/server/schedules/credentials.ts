/**
 * What a schedule's gateway key needs beyond minting it: revoking it without losing
 * it when the gateway is down, and finding a session to act with when nobody is
 * signed in.
 *
 * A key that cannot be revoked now is **queued** (`scheduleKeyRevocations`) with its
 * own sealed secret, and `retryRevocations` (run by the scheduler's housekeeping)
 * tries again with the person's latest session, else the key itself, backing off, and
 * gives up after `MAX_ATTEMPTS` (the key's expiry is the backstop). The queue is not
 * an owner-keyed collection: it outlives the account on purpose, since an erased
 * account is exactly when a live key must still be revoked.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { open } from "$lib/server/mcp/secretBox";
import type { ScheduleCredential } from "$lib/types/Schedule";
import { revokeKey } from "./gatewayKeys";

export const MAX_REVOCATION_ATTEMPTS = 20;

/** The person's most recent session token that has not expired, or undefined. */
export async function sessionTokenFor(userId: ObjectId): Promise<string | undefined> {
	const session = await collections.sessions.find({ userId }).sort({ updatedAt: -1 }).next();
	const token = session?.oauth?.token;
	if (!token?.value) return undefined;
	if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) return undefined;
	return token.value;
}

function secretOf(sealed: string): string | undefined {
	try {
		return open(sealed);
	} catch {
		return undefined;
	}
}

/** Revoke now with what is at hand; false when the gateway could not say. */
async function tryRevoke(keyId: string, bearers: (string | undefined)[]): Promise<boolean> {
	for (const token of bearers) {
		if (token && (await revokeKey({ token, keyId }))) return true;
	}
	return false;
}

/**
 * Revoke a credential's key; when that cannot be confirmed, queue it for retry.
 * Never throws. Returns whether the key is known to be gone.
 */
export async function revokeOrQueue(
	credential: ScheduleCredential,
	userId: ObjectId,
	token?: string
): Promise<boolean> {
	try {
		const own = secretOf(credential.sealed);
		if (await tryRevoke(credential.keyId, [token, own])) return true;
		const now = new Date();
		await collections.scheduleKeyRevocations.insertOne({
			_id: new ObjectId(),
			keyId: credential.keyId,
			sealed: credential.sealed,
			forUser: userId,
			createdAt: now,
			attempts: 1,
			nextAttemptAt: new Date(now.getTime() + 60 * 60_000),
		});
	} catch (err) {
		logger.warn({ err, keyId: credential.keyId }, "schedule_key_revoke_queue_failed");
	}
	return false;
}

/** Retry what is due. Returns how many keys are now gone. */
export async function retryRevocations(now: Date = new Date(), limit = 20): Promise<number> {
	const due = await collections.scheduleKeyRevocations
		.find({ nextAttemptAt: { $lte: now } })
		.sort({ nextAttemptAt: 1 })
		.limit(limit)
		.toArray();
	let gone = 0;
	for (const row of due) {
		const session = await sessionTokenFor(row.forUser).catch(() => undefined);
		if (await tryRevoke(row.keyId, [session, secretOf(row.sealed)])) {
			await collections.scheduleKeyRevocations.deleteOne({ _id: row._id });
			gone += 1;
			continue;
		}
		if (row.attempts + 1 >= MAX_REVOCATION_ATTEMPTS) {
			logger.warn({ keyId: row.keyId }, "schedule_key_revoke_given_up");
			await collections.scheduleKeyRevocations.deleteOne({ _id: row._id });
			continue;
		}
		const backoffMs = Math.min(2 ** row.attempts * 60 * 60_000, 24 * 60 * 60_000);
		await collections.scheduleKeyRevocations.updateOne(
			{ _id: row._id },
			{ $inc: { attempts: 1 }, $set: { nextAttemptAt: new Date(now.getTime() + backoffMs) } }
		);
	}
	return gone;
}

export const SIGN_IN_AGAIN =
	"Sign in again and turn it back on: the key this schedule runs with stopped working.";

/** The credentials a person's schedules hold, revoked (or queued) and forgotten; chat schedules that ran on them are switched off. */
export async function revokeAllFor(
	userId: ObjectId,
	options: { disable: boolean }
): Promise<number> {
	const rows = await collections.schedules
		.find({ userId, credential: { $exists: true } })
		.toArray();
	for (const row of rows) {
		if (row.credential) await revokeOrQueue(row.credential, userId);
		await collections.schedules.updateOne(
			{ _id: row._id, "credential.keyId": row.credential?.keyId },
			{
				$unset: { credential: "" },
				...(options.disable
					? {
							$set: {
								enabled: false,
								nextRunAt: null,
								disabledReason: SIGN_IN_AGAIN,
								updatedAt: new Date(),
							},
						}
					: {}),
			}
		);
	}
	return rows.length;
}
