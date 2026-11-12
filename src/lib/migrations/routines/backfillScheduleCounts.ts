import { ObjectId } from "mongodb";
import type { Collection } from "mongodb";
import type { Schedule, ScheduleCount } from "$lib/types/Schedule";

export const MIGRATION_BACKFILL_SCHEDULE_COUNTS = new ObjectId("6a2c7d1e4b9f4a3c8e5d0f61");

/**
 * Sets every user's schedule counter (the atomic count behind the per-user cap) to the number of
 * schedules they really have, so users whose schedules predate the counter are held to the cap from
 * the first create. Counters of users with no schedules are removed. Returns how many users have a
 * counter afterwards.
 */
export async function backfillScheduleCounts(db: {
	schedules: Collection<Schedule>;
	scheduleCounts: Collection<ScheduleCount>;
}): Promise<number> {
	const totals = await db.schedules
		.aggregate<{ _id: ObjectId; count: number }>([
			{ $group: { _id: "$userId", count: { $sum: 1 } } },
		])
		.toArray();
	for (const { _id, count } of totals) {
		await db.scheduleCounts.updateOne({ _id }, { $set: { count } }, { upsert: true });
	}
	await db.scheduleCounts.deleteMany({ _id: { $nin: totals.map((t) => t._id) } });
	return totals.length;
}
