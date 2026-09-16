import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { downloadDeliverable } from "$lib/server/execution/deliverables";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * Serves a persisted `execute_code` deliverable, access-controlled exactly
 * like the message-attachment output route (`conversation/[id]/output/[sha256]`):
 * the same conversation-ownership check, the same "download, never render"
 * response shape. `FileCard` builds this URL client-side from the
 * conversationId + sha256 the resolved update carries — never a stored URL.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);
	const sha256 = z.string().parse(params.sha256);

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const file = await downloadDeliverable(conversationId, sha256);
	if (!file) error(404, "File not found");

	return new Response(new Uint8Array(file.buffer), {
		headers: {
			"Content-Type": file.mime || "application/octet-stream",
			"Content-Security-Policy":
				"default-src 'none'; script-src 'none'; style-src 'none'; sandbox;",
			"Content-Disposition": `attachment; filename="${file.name.replace(/[\r\n"]/g, "")}"`,
			"Content-Length": file.buffer.length.toString(),
			"Accept-Range": "bytes",
		},
	});
};
