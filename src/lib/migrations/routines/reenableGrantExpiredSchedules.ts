import { ObjectId } from "mongodb";
import type { Collection } from "mongodb";
import type { Schedule } from "$lib/types/Schedule";
import { nextOccurrence } from "$lib/server/schedules/recurrence";
import { LEGACY_SIGN_IN_AGAIN } from "$lib/server/schedules/grants";

export const MIGRATION_REENABLE_GRANT_EXPIRED = new ObjectId("6a0b5c2e9d3f4a1b8c7e6d50");

/**
 * Before background-grant expiry stopped disabling schedules, an expired grant switched every chat
 * schedule of the user off with a fixed sentence. That sentence identifies those rows reliably (the user
 * never writes a `disabledReason`), so they are switched back on: the warning is derived from the grant
 * now and the schedule resumes on the user's next sign-in. A user's own Stop and a merge keep their own
 * reasons and are left alone. Returns how many schedules were re-enabled.
 */
export async function reenableGrantExpiredSchedules(db: {
	schedules: Collection<Schedule>;
}): Promise<number> {
	const rows = await db.schedules
		.find({ kind: "chat", enabled: false, disabledReason: LEGACY_SIGN_IN_AGAIN })
		.toArray();
	const now = new Date();
	for (const row of rows) {
		await db.schedules.updateOne(
			{ _id: row._id, enabled: false },
			{
				$set: {
					enabled: true,
					nextRunAt: nextOccurrence(row.recurrence, row.timezone, now, row.anchorAt),
					consecutiveFailures: 0,
					updatedAt: now,
				},
				$unset: { disabledReason: "" },
			}
		);
	}
	return rows.length;
}
