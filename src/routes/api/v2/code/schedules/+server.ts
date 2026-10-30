/**
 * Scheduled actions: the caller's own list, and creation. Owner-only, and
 * under `/api/v2/code/`, so a sign-in older than 7 days is refused by the
 * hook before this runs. See `server/schedules/` for what a schedule is.
 *
 * Chat schedules are for every signed-in user; agent schedules are only seen
 * and made by a person the /code panel is on for (`requireSchedulesAccess`).
 * Creating or switching on a chat schedule makes its gateway key with the
 * caller's own session token, so it travels from here to the store.
 */

import { error } from "@sveltejs/kit";
import type { RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { answering, requireJsonBody, requireSchedulesAccess } from "$lib/server/schedules/api";
import { createSchedule, listSchedules, scheduleView } from "$lib/server/schedules/store";
import { maxSchedulesPerUser } from "$lib/server/schedules/limits";

export const GET: RequestHandler = async ({ locals }) => {
	const { userId, agents } = await requireSchedulesAccess(locals);
	const rows = (await listSchedules(userId)).filter((row) => agents || row.kind !== "agent");
	return superjsonResponse({
		schedules: await Promise.all(rows.map((row) => scheduleView(row))),
		limit: maxSchedulesPerUser(),
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const access = await requireSchedulesAccess(locals);
	requireJsonBody(request);
	const body = await request.json().catch(() => null);
	// The kind defaults to "agent" in the store (every body before chat had none).
	const kind = (body as { kind?: unknown } | null)?.kind ?? "agent";
	if (kind === "agent" && !access.agents) error(404, "Coding agents are not turned on here.");
	const schedule = await answering(() =>
		createSchedule(access.userId, body, { token: locals.token })
	);
	return superjsonResponse({ schedule: await scheduleView(schedule) }, { status: 201 });
};
