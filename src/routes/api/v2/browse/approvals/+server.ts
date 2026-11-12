/**
 * The user's pending browse approvals (ADR 0116), for the Needs-you inbox: a browsing sub-agent
 * waiting on a click, from any of the user's conversations. The machines' own asks are read live
 * from the machines; these live in the chat's database, so the inbox reads them here.
 * Only the caller's own conversations, ever; an expired ask is not listed.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";

const MAX_LISTED = 50;

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	const pending = await collections.mcpElicitations
		.find({
			status: "pending",
			"request.browse": { $exists: true },
			expiresAt: { $gt: new Date() },
		})
		.sort({ createdAt: -1 })
		.limit(MAX_LISTED * 4)
		.toArray();
	if (pending.length === 0) return json({ approvals: [] });
	const mine = await collections.conversations
		.find(
			{ _id: { $in: pending.map((row) => row.conversationId) }, ...authCondition(locals) },
			{ projection: { _id: 1, title: 1 } }
		)
		.toArray();
	const titles = new Map(mine.map((c) => [c._id.toString(), c.title ?? ""]));
	return json({
		approvals: pending
			.filter((row) => titles.has(row.conversationId.toString()))
			.slice(0, MAX_LISTED)
			.map((row) => ({
				elicitationId: row.elicitationId,
				conversationId: row.conversationId.toString(),
				conversationTitle: titles.get(row.conversationId.toString()) ?? "",
				request: row.request,
				expiresAt: row.expiresAt?.getTime(),
			})),
	});
};
