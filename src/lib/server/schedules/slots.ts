import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";

/**
 * The per-user schedule count behind the cap: one `{ _id: userId, count }` row, moved with atomic
 * conditional updates, so two creates racing for the last slot cannot both get it.
 * Rows are the truth; the counter is rebuilt from them whenever it is missing (a user whose
 * schedules predate it, or a merge that moved rows), and by the backfill migration.
 */

function isDuplicateKey(err: unknown): boolean {
	return (err as { code?: number } | null)?.code === 11000;
}

/** Creates the counter from the rows if it does not exist yet. */
async function ensureCounter(userId: ObjectId): Promise<void> {
	if (await collections.scheduleCounts.findOne({ _id: userId }, { projection: { _id: 1 } })) return;
	const count = await collections.schedules.countDocuments({ userId });
	try {
		await collections.scheduleCounts.updateOne(
			{ _id: userId },
			{ $setOnInsert: { count } },
			{ upsert: true }
		);
	} catch (err) {
		// A racing create seeded it first: its value stands.
		if (!isDuplicateKey(err)) throw err;
	}
}

/** Takes one slot if the user is under `cap`. False means the cap is reached; nothing changed. */
export async function claimScheduleSlot(userId: ObjectId, cap: number): Promise<boolean> {
	await ensureCounter(userId);
	const claimed = await collections.scheduleCounts.findOneAndUpdate(
		{ _id: userId, count: { $lt: cap } },
		{ $inc: { count: 1 } }
	);
	return claimed.value !== null;
}

/** Gives a slot back: a schedule was deleted, or its insert failed. Never goes below zero. */
export async function releaseScheduleSlot(userId: ObjectId, by = 1): Promise<void> {
	await collections.scheduleCounts.updateOne(
		{ _id: userId, count: { $gte: by } },
		{ $inc: { count: -by } }
	);
}

/** Sets the counter to the number of rows the user really has. */
export async function reconcileScheduleCount(userId: ObjectId): Promise<number> {
	const count = await collections.schedules.countDocuments({ userId });
	await collections.scheduleCounts.updateOne(
		{ _id: userId },
		{ $set: { count } },
		{ upsert: true }
	);
	return count;
}

/** Drops the counter with the account. */
export async function dropScheduleCount(userId: ObjectId): Promise<void> {
	await collections.scheduleCounts.deleteOne({ _id: userId });
}
