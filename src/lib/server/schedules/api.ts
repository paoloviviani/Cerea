/**
 * What every schedules route shares: the sign-in and deployment gates, the
 * JSON content-type rule, and the mapping of a `ScheduleError` onto an HTTP
 * answer. The routes themselves live under `/api/v2/code/schedules`, so the
 * /code stale-sign-in guard (`hooks/handle.ts`, 7 days) covers every one of
 * them by prefix, with nothing here to remember.
 */

import { error } from "@sveltejs/kit";
import type { ObjectId } from "mongodb";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { codeSchedulesEnabled } from "$lib/server/codeEnabled";
import { ScheduleError } from "./store";

/** Signed in, /code on, schedules not switched off; returns the owner. */
export function requireSchedules(locals: App.Locals): ObjectId {
	requireCodeAgents(locals);
	if (!codeSchedulesEnabled()) error(404, "Scheduled actions are switched off on this deployment.");
	if (!locals.user) error(401, "Login required");
	return locals.user._id;
}

export function requireJsonBody(request: Request): void {
	const contentType = request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
	if (contentType !== "application/json") error(400, "Expected Content-Type: application/json.");
}

/** Run a handler body, turning a `ScheduleError` into its status. */
export async function answering<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof ScheduleError) error(err.status, err.message);
		throw err;
	}
}
