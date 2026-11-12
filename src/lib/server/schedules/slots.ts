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

async function tryClaim(userId: ObjectId, cap: number): Promise<boolean> {
	const claimed = await collections.scheduleCounts.findOneAndUpdate(
		{ _id: userId, count: { $lt: cap } },
		{ $inc: { count: 1 } }
	);
	return claimed.value !== null;
}

/**
 * Corrects a counter that is higher than the rows really are (a slot leaked by a crash between
 * claim and insert, or between delete and release). Downward only, and only if the counter still
 * holds the value that was read, so it never fights a concurrent claim. Returns whether it fixed.
 */
export async function healScheduleCount(userId: ObjectId): Promise<boolean> {
	const row = await collections.scheduleCounts.findOne({ _id: userId });
	if (!row) return false;
	const real = await collections.schedules.countDocuments({ userId });
	if (row.count <= real) return false;
	const { modifiedCount } = await collections.scheduleCounts.updateOne(
		{ _id: userId, count: row.count },
		{ $set: { count: real } }
	);
	return modifiedCount === 1;
}

/** Takes one slot if the user is under `cap`. False means the cap is reached; nothing changed. */
export async function claimScheduleSlot(userId: ObjectId, cap: number): Promise<boolean> {
	await ensureCounter(userId);
	if (await tryClaim(userId, cap)) return true;
	// At the cap by the counter: make sure the counter is not just stale, then retry once.
	return (await healScheduleCount(userId)) && (await tryClaim(userId, cap));
}

/** Gives a slot back: a schedule was deleted, or its insert failed. Never goes below zero. */
export async function releaseScheduleSlot(userId: ObjectId, by = 1): Promise<void> {
	await collections.scheduleCounts.updateOne(
		{ _id: userId, count: { $gte: by } },
		{ $inc: { count: -by } }
	);
}

/** Drops the counter with the account. */
export async function dropScheduleCount(userId: ObjectId): Promise<void> {
	await collections.scheduleCounts.deleteOne({ _id: userId });
}
