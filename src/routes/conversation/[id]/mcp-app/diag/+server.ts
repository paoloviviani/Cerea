import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { MCP_APP_FILE_TOOL } from "$lib/server/execution/deliverables";
import {
	DIAG_KINDS,
	reduceSource,
	reportAllowed,
	pruneReports,
} from "$lib/server/mcp/apps/diagReport";
import { requireSameOriginJson } from "$lib/server/mcp/apps/sameOrigin";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

const bodySchema = z.object({
	connector: z.string().min(1).max(200),
	uri: z.string().max(300).startsWith("ui://"),
	errors: z
		.array(
			z.object({
				kind: z.enum(DIAG_KINDS),
				source: z.string().max(300).optional(),
			})
		)
		.min(1)
		.max(5),
});

/**
 * That an MCP App card's page failed, sent once per card, so an administrator tailing the logs can tell
 * why a card is blank where the user has no console (an installed web app). Metadata only: the connector,
 * the page's `ui://` address, a kind from a fixed list, a count and at most the failing source as scheme,
 * host and path. Never the message text, a query string, page content or anything the user did. The
 * connector and address must be those of a page this conversation really holds. Rate limited per
 * conversation and per user; an excess is dropped without an error.
 */
export const POST: RequestHandler = async ({ params, locals, request, url }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	requireSameOriginJson(request, url);
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid report");

	const held = await collections.codeExecutionOutputs.findOne({
		conversationId,
		tool: MCP_APP_FILE_TOOL,
		appConnector: parsed.data.connector,
		appUri: parsed.data.uri,
	});
	if (!held) error(403, "No such page in this conversation");

	const who = locals.user?._id?.toString() ?? locals.sessionId ?? "";
	const now = Date.now();
	if (reportAllowed(`c|${params.id}`, now) && reportAllowed(`u|${who}`, now)) {
		logger.warn(
			{
				connector: parsed.data.connector,
				uri: parsed.data.uri,
				count: parsed.data.errors.length,
				errors: parsed.data.errors.map((e) => ({ kind: e.kind, source: reduceSource(e.source) })),
			},
			"[mcp-app] the page reported errors"
		);
	}
	pruneReports(now);
	return new Response(null, { status: 204 });
};
