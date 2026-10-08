import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { answering, requireJsonBody, requireSchedules } from "$lib/server/schedules/api";
import {
	deleteSchedule,
	getSchedule,
	scheduleView,
	updateSchedule,
} from "$lib/server/schedules/store";

export const GET: RequestHandler = async ({ locals, params }) => {
	const userId = requireSchedules(locals);
	const schedule = await answering(() => getSchedule(userId, params.id ?? ""));
	return superjsonResponse({ schedule: await scheduleView(schedule) });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const userId = requireSchedules(locals);
	requireJsonBody(request);
	const body = await request.json().catch(() => null);
	const schedule = await answering(() => updateSchedule(userId, params.id ?? "", body));
	return superjsonResponse({ schedule: await scheduleView(schedule) });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const userId = requireSchedules(locals);
	await answering(() => deleteSchedule(userId, params.id ?? ""));
	return superjsonResponse({ deleted: true });
};
