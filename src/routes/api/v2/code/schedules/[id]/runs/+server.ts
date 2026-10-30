import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { answering, assertKindVisible, requireSchedulesAccess } from "$lib/server/schedules/api";
import { getSchedule, listRuns, runView, scheduleView } from "$lib/server/schedules/store";

/** The schedule's history, newest first: every occurrence considered, fired or not. */
export const GET: RequestHandler = async ({ locals, params, url }) => {
	const access = await requireSchedulesAccess(locals);
	const userId = access.userId;
	const id = params.id ?? "";
	const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
	const schedule = await answering(() => getSchedule(userId, id));
	assertKindVisible(schedule, access);
	const runs = await answering(() => listRuns(userId, id, Number.isFinite(limit) ? limit : 50));
	return superjsonResponse({
		schedule: await scheduleView(schedule),
		runs: runs.map(runView),
	});
};
