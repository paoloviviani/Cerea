import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { requireSameOriginJson } from "$lib/server/mcp/apps/sameOrigin";
import { error } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

const MAX_REPORTS_PER_MINUTE = 10;
const reports = new Map<string, number[]>();

const bodySchema = z.object({
	connector: z.string().min(1).max(200),
	uri: z.string().max(300).optional(),
	errors: z
		.array(
			z.object({
				kind: z.string().max(20),
				message: z.string().max(300),
				source: z.string().max(300).optional(),
				line: z.number().int().optional(),
			})
		)
		.min(1)
		.max(5),
});

/**
 * What an MCP App card saw go wrong in its page (a script error, a refused load, a policy violation),
 * sent once per card, so an admin tailing the logs can tell why a card is blank where the user has no
 * console to read (an installed web app). Only the diagnostics the card's own shim collected: the
 * connector, the page's address and a few short messages. Never the page's content or what the user did.
 * Capped in size and in rate; an excess is dropped without an error.
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

	const key = `${params.id}|${locals.user?._id?.toString() ?? locals.sessionId ?? ""}`;
	const now = Date.now();
	const recent = (reports.get(key) ?? []).filter((at) => now - at < 60_000);
	if (recent.length < MAX_REPORTS_PER_MINUTE) {
		recent.push(now);
		reports.set(key, recent);
		logger.warn(
			{ connector: parsed.data.connector, uri: parsed.data.uri, errors: parsed.data.errors },
			"[mcp-app] the page reported errors"
		);
	}
	if (reports.size > 5000) {
		for (const [k, list] of reports) if (list.every((at) => now - at >= 60_000)) reports.delete(k);
	}
	return new Response(null, { status: 204 });
};
