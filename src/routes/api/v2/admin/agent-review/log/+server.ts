/** The reviewer's log across all machines (administrator only), newest first, keyset paging. */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/admin";
import { listReviewLog } from "$lib/server/agentReview";
import { PERMISSION_CLASSES, type PermissionClass } from "$lib/types/machineProtocol";
import type { ReviewOutcome } from "$lib/types/AgentReview";

const OUTCOMES: ReviewOutcome[] = ["allowed", "escalated", "error"];

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireAdmin(locals);
	const cls = url.searchParams.get("class");
	const outcome = url.searchParams.get("outcome");
	const before = url.searchParams.get("before");
	if (cls && !PERMISSION_CLASSES.includes(cls as PermissionClass)) error(400, "Unknown class.");
	if (outcome && !OUTCOMES.includes(outcome as ReviewOutcome)) error(400, "Unknown outcome.");
	const beforeDate = before ? new Date(before) : undefined;
	if (beforeDate && Number.isNaN(beforeDate.getTime())) error(400, "Bad `before`.");
	const limit = Number(url.searchParams.get("limit") ?? "") || undefined;
	const { entries, next } = await listReviewLog({
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
};
