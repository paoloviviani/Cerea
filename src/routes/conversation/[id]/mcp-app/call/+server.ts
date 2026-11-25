import type { RequestHandler } from "./$types";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { callToolFromPage } from "$lib/server/mcp/apps/pageCall";
import { error, json } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";

const bodySchema = z.object({
	connector: z.string().min(1).max(200),
	tool: z.string().min(1).max(200),
	arguments: z.record(z.string(), z.unknown()).default({}),
	/** Present only after the user's click on Cerea's own approval card. */
	approval: z.enum(["once", "conversation"]).optional(),
});

/**
 * A tool call an MCP App page asked for (docs/dev/adr-mcp-apps.md). The browser forwards it from the
 * card's bridge; the server resolves the connector for this user and runs it through the model's
 * approval gate. A page itself cannot reach this route: it has an opaque origin and no session cookie.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user && !locals.sessionId) error(401, "Unauthorized");
	if (!ObjectId.isValid(params.id)) error(404, "Conversation not found");
	const conversationId = new ObjectId(params.id);

	const conversation = await collections.conversations.findOne(
		{ _id: conversationId, ...authCondition(locals) },
		{ projection: { _id: 1, toolApprovalOverride: 1, approvedTools: 1 } }
	);
	if (!conversation) error(404, "Conversation not found");

	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid tool call");

	// The page's connector is one this conversation really holds a stored page of (recorded on the
	// server when the tool answered), not whatever the browser names.
	const held = await collections.codeExecutionOutputs.findOne({
		conversationId,
		tool: "mcp_app",
		summary: parsed.data.connector,
	});
	if (!held) error(403, "No page from that connector in this conversation");

	const settings = await collections.settings.findOne(authCondition(locals));
	const outcome = await callToolFromPage({
		conversation,
		settings,
		userId: locals.user?._id,
		connector: parsed.data.connector,
		tool: parsed.data.tool,
		args: parsed.data.arguments,
		approval: parsed.data.approval,
		signal: request.signal,
	});
	if (outcome.ok) return json({ ok: true, result: outcome.result });
	return json(
		{ ok: false, code: outcome.code, message: outcome.message, approval: outcome.approval },
		{ status: outcome.status }
	);
};
