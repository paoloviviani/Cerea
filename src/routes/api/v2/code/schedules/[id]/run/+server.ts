import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { answering, assertKindVisible, requireSchedulesAccess } from "$lib/server/schedules/api";
import { runNow } from "$lib/server/schedules/scheduler";
import { getSchedule, runView } from "$lib/server/schedules/store";

/** "Run now": one immediate run of the caller's own schedule (the executor's overlap rule applies). */
export const POST: RequestHandler = async ({ locals, params }) => {
	const access = await requireSchedulesAccess(locals);
	assertKindVisible(await answering(() => getSchedule(access.userId, params.id ?? "")), access);
	const run = await answering(() => runNow(access.userId, params.id ?? ""));
	return superjsonResponse({ run: runView(run) });
};
