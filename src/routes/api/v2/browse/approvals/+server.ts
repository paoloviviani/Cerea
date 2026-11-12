/**
 * The user's pending browse approvals (ADR 0116), for the Needs-you inbox: a browsing sub-agent
 * waiting on a click, from any of the user's conversations. The machines' own asks are read live
 * from the machines; these live in the chat's database, so the inbox reads them here.
 *
 * Only the caller's own asks: the rows carry their user's id and are read by it (indexed), never
 * by scanning others'. An ask the server stored without a user is not listed. A picture larger
 * than a thumbnail is left out of the list (the chat's own card has it); the response is capped.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { collections } from "$lib/server/database";

const MAX_LISTED = 50;
/** Base64 characters: about 100 KB. */
const MAX_THUMBNAIL_CHARS = 100_000;

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, "Unauthorized");
	const pending = await collections.mcpElicitations
		.find({
			userId: locals.user._id,
			status: "pending",
			"request.browse": { $exists: true },
			expiresAt: { $gt: new Date() },
		})
		.sort({ createdAt: -1 })
		.limit(MAX_LISTED)
		.toArray();
	if (pending.length === 0) return json({ approvals: [] });
	const conversations = await collections.conversations
		.find(
			{ _id: { $in: pending.map((row) => row.conversationId) }, userId: locals.user._id },
			{ projection: { _id: 1, title: 1 } }
		)
		.toArray();
	const titles = new Map(conversations.map((c) => [c._id.toString(), c.title ?? ""]));
	return json({
		approvals: pending
			.filter((row) => titles.has(row.conversationId.toString()))
			.map((row) => {
				const { screenshot, ...browse } = row.request.browse ?? { sentence: "", site: "" };
				return {
					elicitationId: row.elicitationId,
					conversationId: row.conversationId.toString(),
					conversationTitle: titles.get(row.conversationId.toString()) ?? "",
					request: {
						...row.request,
						browse: {
							...browse,
							...(screenshot && screenshot.base64.length <= MAX_THUMBNAIL_CHARS
								? { screenshot }
								: {}),
						},
					},
					expiresAt: row.expiresAt?.getTime(),
				};
			}),
	});
};
