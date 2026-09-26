import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { storeDeliverable } from "$lib/server/execution/deliverables";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";

/**
 * The browser uploads a run's own output files here once they settle —
 * every run path, through `uploadRunFiles` (an `execute_code` card, a chat
 * code block, an artifact cell), which reads the bytes out of its
 * ExecutionSession the same way FileCard does for a live download and posts
 * them as `multipart/form-data` (one or more `file` parts). Every produced
 * file is a deliverable (see `$lib/server/execution/deliverables.ts`'s
 * header); a block's or a cell's are then attached to their message through
 * `../run-files`.
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

/**
 * Lists this conversation's persisted deliverables — the metadata rows behind
 * the download cards (`codeExecutionOutputs`), newest first. Same
 * conversation-ownership check as the POST above and the per-file download
 * route; the bytes themselves stay behind `[sha256]`.
 *
 * Conversation-scoped by construction: the store keys rows by conversationId
 * (no cross-conversation index exists), so the panel shows this chat's files,
 * persistent across reloads and devices for the 30-day retention window.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const files = await collections.codeExecutionOutputs
		.find({ conversationId })
		.project({ name: 1, mime: 1, size: 1, sha256: 1, createdAt: 1 })
		.sort({ createdAt: -1 })
		.toArray();

	return json({
		files: files.map((file) => ({
			name: file.name,
			mime: file.mime,
			size: file.size,
			sha256: file.sha256,
			createdAt: file.createdAt.toISOString(),
		})),
	});
};
