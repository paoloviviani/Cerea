import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import {
	answering,
	assertKindVisible,
	requireJsonBody,
	requireSchedulesAccess,
} from "$lib/server/schedules/api";
import {
	deleteSchedule,
	getSchedule,
	scheduleView,
	updateSchedule,
} from "$lib/server/schedules/store";

export const GET: RequestHandler = async ({ locals, params }) => {
	const access = await requireSchedulesAccess(locals);
	const schedule = await answering(() => getSchedule(access.userId, params.id ?? ""));
	assertKindVisible(schedule, access);
	return superjsonResponse({ schedule: await scheduleView(schedule) });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const access = await requireSchedulesAccess(locals);
	requireJsonBody(request);
	const body = await request.json().catch(() => null);
	assertKindVisible(await answering(() => getSchedule(access.userId, params.id ?? "")), access);
	// Switching a chat schedule on may need a new key, made with this session's token.
	const schedule = await answering(() =>
		updateSchedule(access.userId, params.id ?? "", body, { token: locals.token })
	);
	return superjsonResponse({ schedule: await scheduleView(schedule) });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const access = await requireSchedulesAccess(locals);
	assertKindVisible(await answering(() => getSchedule(access.userId, params.id ?? "")), access);
	await answering(() => deleteSchedule(access.userId, params.id ?? "", { token: locals.token }));
	return superjsonResponse({ deleted: true });
};
