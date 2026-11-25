import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { openDeliverable } from "$lib/server/execution/deliverables";
import { appsAllowedFor } from "$lib/server/mcp/appsPolicy";
import { MCP_APP_FILE_TOOL } from "$lib/server/mcp/apps/snapshot";
import { error } from "@sveltejs/kit";
import { Readable } from "node:stream";
import { ObjectId } from "mongodb";
import { z } from "zod";

/**
 * The stored copy of an MCP App page, for the card's reload (docs/dev/adr-mcp-apps.md, section 4). The
 * browser reads it with `fetch` and puts it in a sandboxed iframe's `srcdoc`; it is served as plain text
 * so it is never rendered as a document of this origin. Access is the conversation's owner's, and the
 * connector recorded with the page must still be allowed to show apps.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);
	const sha256 = z
		.string()
		.regex(/^[0-9a-f]{64}$/)
		.safeParse(params.sha256);
	if (!sha256.success) error(404, "Not found");

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const row = await collections.codeExecutionOutputs.findOne({
		conversationId,
		sha256: sha256.data,
		tool: MCP_APP_FILE_TOOL,
	});
	if (!row) error(404, "Not found");
	// The connector is the one recorded with the stored page on the server, not anything the browser says.
	const connector = row.summary;
	if (!connector || !(await appsAllowedFor(connector, locals.user?._id))) {
		error(403, "Apps are not allowed here");
	}
	const file = await openDeliverable(conversationId, sha256.data);
	if (!file) error(404, "Not found");

	return new Response(Readable.toWeb(file.stream) as ReadableStream, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Security-Policy": "default-src 'none'; sandbox;",
			"X-Content-Type-Options": "nosniff",
			"Cache-Control": "private, max-age=3600",
			"Content-Length": file.size.toString(),
		},
	});
};
