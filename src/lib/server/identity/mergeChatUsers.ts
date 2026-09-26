/**
 * Fold one stray chat account into the account the gateway says is the same
 * person (ADR 0093 §7.2), over `USER_KEYED_COLLECTIONS`.
 *
 * Triggered by the login resolution (`gatewayLogin.ts`, §4.3 step 5) and by
 * the session check's background fold (§4.4, once that lands). **Merge is
 * not erasure**: nothing of the target's is ever touched or removed.
 *
 * Crash-safe by construction, not by a saga log: `stray.mergedInto` and
 * `mergeState: "moving"` are set *before* anything in the registry moves, so
 * a stray found with `mergedInto` already set is a resume, not a fresh
 * merge — every registry entry's `merge` is itself idempotent (a document
 * already reassigned to the target no longer matches `{owner: stray}`, so a
 * second pass over it moves nothing), and the stray's own row is deleted
 * only once every entry has run. A crash between two entries simply means
 * the next call re-runs the ones that already finished and finds nothing
 * left to do.
 */
import type { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { USER_KEYED_COLLECTIONS } from "./userKeyedCollections";

export interface MergeChatUsersResult {
	stray: string;
	target: string;
	counts: Record<string, number>;
}

export async function mergeChatUsers(
	stray: ObjectId,
	target: ObjectId
): Promise<MergeChatUsersResult> {
	if (stray.equals(target)) {
		throw new Error("mergeChatUsers: the stray and the target are the same account");
	}

	await collections.users.updateOne(
		{ _id: stray },
		{ $set: { mergedInto: target, mergeState: "moving" } }
	);

	const counts: Record<string, number> = {};
	for (const entry of USER_KEYED_COLLECTIONS) {
		counts[entry.name] = await entry.merge(stray, target);
	}

	await collections.users.deleteOne({ _id: stray });

	logger.info({ stray: stray.toString(), target: target.toString(), counts }, "chat_user_merged");

	return { stray: stray.toString(), target: target.toString(), counts };
}
