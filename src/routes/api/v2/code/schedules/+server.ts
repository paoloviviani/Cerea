/**
 * Scheduled actions: the caller's own list, and creation. Owner-only, and
 * under `/api/v2/code/`, so a sign-in older than 7 days is refused by the
 * hook before this runs. See `server/schedules/` for what a schedule is.
 */

import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { answering, requireJsonBody, requireSchedules } from "$lib/server/schedules/api";
import { createSchedule, listSchedules, scheduleView } from "$lib/server/schedules/store";
import { maxSchedulesPerUser } from "$lib/server/schedules/limits";

export const GET: RequestHandler = async ({ locals }) => {
	const userId = requireSchedules(locals);
	const rows = await listSchedules(userId);
	return superjsonResponse({
		schedules: await Promise.all(rows.map((row) => scheduleView(row))),
		limit: maxSchedulesPerUser(),
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const userId = requireSchedules(locals);
	requireJsonBody(request);
	const body = await request.json().catch(() => null);
	const schedule = await answering(() => createSchedule(userId, body));
	return superjsonResponse({ schedule: await scheduleView(schedule) }, { status: 201 });
};
