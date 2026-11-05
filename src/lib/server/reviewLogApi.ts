/** The shared half of the two review-log endpoints (admin: all machines; user: the caller's own). */
import { error, json } from "@sveltejs/kit";
import type { ObjectId } from "mongodb";
import { listReviewLog } from "$lib/server/agentReview";
import { PERMISSION_CLASSES, type PermissionClass } from "$lib/types/machineProtocol";
import type { ReviewOutcome } from "$lib/types/AgentReview";

const OUTCOMES: ReviewOutcome[] = ["allowed", "escalated", "error", "read-only"];

/**
 * Parse the filters from the query and answer a page. `userId` is the scope and comes from the
 * session, never from the query: pass it for the user endpoint, omit it only for the admin one.
 */
export async function reviewLogResponse(url: URL, userId?: ObjectId): Promise<Response> {
	const cls = url.searchParams.get("class");
	const outcome = url.searchParams.get("outcome");
	const before = url.searchParams.get("before");
	if (cls && !PERMISSION_CLASSES.includes(cls as PermissionClass)) error(400, "Unknown class.");
	if (outcome && !OUTCOMES.includes(outcome as ReviewOutcome)) error(400, "Unknown outcome.");
	const beforeDate = before ? new Date(before) : undefined;
	if (beforeDate && Number.isNaN(beforeDate.getTime())) error(400, "Bad `before`.");
	const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
	const { entries, next } = await listReviewLog({
		userId,
		deviceId: url.searchParams.get("machine") || undefined,
		class: (cls as PermissionClass) || undefined,
		outcome: (outcome as ReviewOutcome) || undefined,
		before: beforeDate,
		limit,
	});
	return json({
		entries: entries.map((e) => ({
			id: e._id?.toString(),
			time: e.time,
			machine: e.machine,
			deviceId: e.deviceId,
			sessionId: e.sessionId,
			class: e.class,
			summary: e.summary,
			probability: e.probability,
			outcome: e.outcome,
			reason: e.reason,
			applied: e.applied,
			modelId: e.modelId,
		})),
		next,
	});
}
