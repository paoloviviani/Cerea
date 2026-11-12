/**
 * "Open browser" (ADR 0116, C109): opens a page on one of the user's computers with no task.
 *
 * `{deviceId, url?, conversationId?}`. With a conversation (the composer) the page is tied to it
 * as its kept page, so the next browse there continues on it with no approval; without one (a
 * computer's card in Connectors) it is just the user's own tab. Checks, in order: the user, the
 * feature switch, the conversation is theirs, the computer is theirs and its browser is ready
 * (offline: 409 "<computer> is offline"), the address (http(s) only, not on the deny list), and
 * that no browse task holds the machine ("busy", 409).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { authCondition } from "$lib/server/auth";
import { collections } from "$lib/server/database";
import { browseMachinesFor } from "$lib/server/browser/availability";
import { requireBrowserUse } from "$lib/server/browser/gate";
import { mongoChoiceStore } from "$lib/server/browser/machineChoice";
import { openBrowserPage, parseOpenUrl } from "$lib/server/browser/open";

const bodySchema = z.object({
	deviceId: z.string().min(1).max(64),
	url: z.string().max(4096).optional(),
	conversationId: z.string().max(64).optional(),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const { userId } = requireBrowserUse(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid request");
	const { deviceId, conversationId } = parsed.data;

	if (conversationId !== undefined) {
		if (!ObjectId.isValid(conversationId)) error(404, "Conversation not found");
		const conversation = await collections.conversations.findOne(
			{ _id: new ObjectId(conversationId), ...authCondition(locals), userId },
			{ projection: { _id: 1 } }
		);
		if (!conversation) error(404, "Conversation not found");
	}

	// The computer must be the caller's own, paired.
	const name = await mongoChoiceStore.nameOf(userId, deviceId);
	if (name === undefined) error(404, "No such computer.");
	const ready = await browseMachinesFor(locals);
	const machine = ready.find((m) => m.id === deviceId);
	if (!machine) error(409, `${name} is offline.`);

	const address = parseOpenUrl(parsed.data.url);
	if ("error" in address) error(400, address.error);

	const result = await openBrowserPage({
		userId,
		machine,
		url: address.url,
		conversationId,
	});
	if (!result.ok) {
		return json({ error: result.code, message: result.message }, { status: result.status });
	}
	return json({
		opened: true,
		computer: result.machine,
		title: result.title,
		url: result.url,
		tied: result.tied,
	});
};
