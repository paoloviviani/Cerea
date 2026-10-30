/**
 * What every schedules route shares: the sign-in and deployment gates, the
 * JSON content-type rule, and the mapping of a `ScheduleError` onto an HTTP
 * answer. The routes themselves live under `/api/v2/code/schedules`, so the
 * /code stale-sign-in guard (`hooks/handle.ts`, 7 days) covers every one of
 * them by prefix, with nothing here to remember.
 */

import { error } from "@sveltejs/kit";
import type { ObjectId } from "mongodb";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { codeAgentsAllowedFor, codeSchedulesEnabled } from "$lib/server/codeEnabled";
import type { Schedule } from "$lib/types/Schedule";
import { schedulesEnabled } from "./limits";
import { ScheduleError } from "./store";

export interface SchedulesAccess {
	userId: ObjectId;
	/** May this person use agent schedules (the /code panel is on for them)? Chat schedules need only the switch. */
	agents: boolean;
}

/**
 * Signed in and scheduled actions not switched off. Chat schedules are for every
 * signed-in user; agent schedules also need the /code panel to be on for this
 * person, which `agents` says, and the routes use to keep the two kinds apart.
 */
export async function requireSchedulesAccess(locals: App.Locals): Promise<SchedulesAccess> {
	requireAuth(locals);
	if (!locals.user) error(401, "Login required");
	if (!schedulesEnabled()) error(404, "Scheduled actions are switched off here.");
	const agents = codeSchedulesEnabled() && (await codeAgentsAllowedFor(locals));
	return { userId: locals.user._id, agents };
}

/** `requireSchedulesAccess` for a route that has no use for the split. */
export async function requireSchedules(locals: App.Locals): Promise<ObjectId> {
	return (await requireSchedulesAccess(locals)).userId;
}

/** A person without the /code panel cannot see or touch an agent schedule: it is a 404, as any other person's. */
export function assertKindVisible(schedule: Pick<Schedule, "kind">, access: SchedulesAccess): void {
	if (schedule.kind === "agent" && !access.agents) error(404, "No such schedule.");
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
