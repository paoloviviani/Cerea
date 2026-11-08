/**
 * `GET /api/v2/conversations/:id/message/:messageId/cost`: what the gateway
 * charged for this assistant turn (`turnCost.ts`), read when the user opens
 * the turn details and the message has no cost yet. A settled cost is stored
 * on `message.stats.cost`, so it is asked for once.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/server/api/utils/resolveConversation";
import { collections } from "$lib/server/database";
import { authCondition } from "$lib/server/auth";
import { turnGatewayCost } from "$lib/server/turnCost";

export const GET: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);
	const conversation = await resolveConversation(params.id ?? "", locals);
	const messageId = params.messageId ?? "";
	const message = conversation.messages.find((m) => m.id === messageId);
	if (!message) error(404, "Message not found");
	if (message.from !== "assistant") error(400, "Only an answer has a cost.");

	// Already known (read from the stream, or fetched before): nothing to ask.
	if (message.stats?.cost) {
		return superjsonResponse({
			available: true,
			cost: message.stats.cost,
			currency: message.stats.costCurrency ?? null,
		});
	}
	if (!locals.token) return superjsonResponse({ available: false });

	const result = await turnGatewayCost(locals.token, messageId);
	if (result.status === "unavailable") return superjsonResponse({ available: false });
	if (result.status === "pending") return superjsonResponse({ available: true, cost: null });

	const set: Record<string, string> = { "messages.$[m].stats.cost": result.cost };
	if (result.currency) set["messages.$[m].stats.costCurrency"] = result.currency;
	await collections.conversations.updateOne(
		{ _id: new ObjectId(conversation._id), ...authCondition(locals) },
		{ $set: set },
		{ arrayFilters: [{ "m.id": messageId }] }
	);
	return superjsonResponse({ available: true, cost: result.cost, currency: result.currency });
};
