import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { storeDeliverable } from "$lib/server/execution/deliverables";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";

/**
 * The browser uploads a run's own output files here once they settle — see
 * CodeExecutionCard.svelte, which reads the bytes out of its ExecutionSession
 * the same way FileCard already does for a live download, and posts them as
 * `multipart/form-data` (one or more `file` parts). This is the only caller:
 * a fence run or artifact cell never reaches this route, which is what keeps
 * "deliverable" scoped to a tool run's own surfaced output (see
 * `$lib/server/execution/deliverables.ts`'s header).
 *
 * Access is the same conversation-ownership check the resolve endpoint and
 * the message-attachment output route use (`authCondition`); there is no
 * separate capability for "may persist a deliverable" because a deliverable
 * is just this user's own output, stored the same way their uploads are.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const form = await request.formData().catch(() => null);
	if (!form) error(400, "Invalid upload");

	const files = form
		.getAll("file")
		.filter((entry): entry is File => entry instanceof File && entry.size > 0);
	if (files.length === 0) error(400, "No file provided");

	const refs = [];
	for (const file of files) {
		const bytes = Buffer.from(await file.arrayBuffer());
		const result = await storeDeliverable({
			conversationId,
			userId: locals.user?._id,
			name: file.name,
			mime: file.type || "application/octet-stream",
			bytes,
		});
		if (!result.ok) error(result.status, result.error);
		refs.push(result.ref);
	}

	return json({ files: refs });
};
