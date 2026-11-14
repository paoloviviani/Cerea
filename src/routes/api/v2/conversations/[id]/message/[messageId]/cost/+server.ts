/**
 * `GET /api/v2/conversations/:id/message/:messageId/cost`: what the gateway
 * charged for this assistant turn (`turnCost.ts`), read when the user opens
 * the turn details unless the turn already stored its settled cost
 * (`turnCostSettle.ts` does that when the turn ends). This is the fallback for
 * a cost that is still provisional or missing; a settled cost is stored with
 * `stats.costSource = "gateway"`, so it is asked for once.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireAuth } from "$lib/server/api/utils/requireAuth";
import { resolveConversation } from "$lib/server/api/utils/resolveConversation";
import { authCondition } from "$lib/server/auth";
import { turnGatewayCost } from "$lib/server/turnCost";
import { storeSettledCost, turnGatewayToken } from "$lib/server/turnCostSettle";

export const GET: RequestHandler = async ({ locals, params }) => {
	requireAuth(locals);
	const conversation = await resolveConversation(params.id ?? "", locals);
	const messageId = params.messageId ?? "";
	const message = conversation.messages.find((m) => m.id === messageId);
	if (!message) error(404, "Message not found");
	if (message.from !== "assistant") error(400, "Only an answer has a cost.");

	// Settled by the gateway already (at the end of the turn, or fetched before): nothing to ask.
	if (message.stats?.cost && message.stats.costSource === "gateway") {
		return superjsonResponse({
			available: true,
			cost: message.stats.cost,
			currency: message.stats.costCurrency ?? null,
		});
	}
	// The credential the turn's own requests used: the user's token, or the
	// deployment's key when it does not use personal tokens (the tag is unique
	// to the turn either way).
	// A cost the stream reported is provisional (main model only): when the gateway cannot say
	// better, it stands.
	const provisional = message.stats?.cost
		? { available: true, cost: message.stats.cost, currency: message.stats.costCurrency ?? null }
		: undefined;
	const token = turnGatewayToken(locals);
	if (!token) return superjsonResponse(provisional ?? { available: false });

	const result = await turnGatewayCost(token, messageId);
	if (result.status === "unavailable")
		return superjsonResponse(provisional ?? { available: false });
	if (result.status === "pending")
		return superjsonResponse(provisional ?? { available: true, cost: null });

	await storeSettledCost(
		{ _id: new ObjectId(conversation._id), ...authCondition(locals) },
		messageId,
		result
	);
	return superjsonResponse({ available: true, cost: result.cost, currency: result.currency });
};
