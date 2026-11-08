import { ObjectId } from "mongodb";
import type { Collection } from "mongodb";
import type { Conversation } from "$lib/types/Conversation";

export const MIGRATION_BACKFILL_LAST_ACTIVITY = new ObjectId("6a1f3b8e5c2d4a7b9e0c1d52");

const BATCH = 500;

/**
 * Gives every conversation without `lastActivityAt` one: the newest message's
 * `createdAt`, else `updatedAt`, else `createdAt`. Housekeeping bumped
 * `updatedAt` on chats nobody touched, so the messages are the truer record.
 * Only conversations still missing the field are read, so a re-run (or a run
 * interrupted part-way) picks up where it stopped and rewrites nothing.
 * Returns how many were filled.
 */
export async function backfillLastActivity(db: {
	conversations: Collection<Conversation>;
}): Promise<number> {
	let filled = 0;
	for (;;) {
		const rows = await db.conversations
			.aggregate<{ _id: ObjectId; at?: Date }>([
				{ $match: { lastActivityAt: { $exists: false } } },
				{ $limit: BATCH },
				{
					$project: {
						at: {
							$ifNull: [{ $max: "$messages.createdAt" }, { $ifNull: ["$updatedAt", "$createdAt"] }],
						},
					},
				},
			])
			.toArray();
		if (rows.length === 0) return filled;
		const now = new Date();
		const res = await db.conversations.bulkWrite(
			rows.map((row) => ({
				updateOne: {
					filter: { _id: row._id, lastActivityAt: { $exists: false } },
					update: { $set: { lastActivityAt: row.at ?? now } },
				},
			})),
			{ ordered: false }
		);
		filled += res.modifiedCount;
		if (res.modifiedCount === 0) return filled;
	}
}
