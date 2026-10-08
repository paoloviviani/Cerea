import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { answering, requireSchedules } from "$lib/server/schedules/api";
import { runNow } from "$lib/server/schedules/scheduler";
import { runView } from "$lib/server/schedules/store";

/** "Run now": one immediate run of the caller's own schedule (the executor's overlap rule applies). */
export const POST: RequestHandler = async ({ locals, params }) => {
	const userId = requireSchedules(locals);
	const run = await answering(() => runNow(userId, params.id ?? ""));
	return superjsonResponse({ run: runView(run) });
};
