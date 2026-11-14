/**
 * Storing the gateway's settled cost on a finished turn.
 *
 * The cost summed from the stream covers only the main model's calls and is
 * provisional. The gateway's total for the turn's tag (`turnCost.ts`) covers
 * every tagged call, sub-agents included, so once a turn ends it is read and
 * stored as `stats.cost` with `stats.costSource = "gateway"`. The turn details
 * overlay reads on demand only when that has not happened.
 */
import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { turnGatewayCost, type TurnCostResult } from "$lib/server/turnCost";

/** The credential the turn's own requests used: the user's token, or the deployment's key. */
export function turnGatewayToken(locals: { token?: string } | undefined): string | undefined {
	return (config.USE_USER_TOKEN === "true" ? locals?.token : config.OPENAI_API_KEY) || undefined;
}

/**
 * Writes a settled cost onto the message. Touches only the cost fields, so it
 * cannot clobber anything else the message holds.
 */
export async function storeSettledCost(
	filter: Record<string, unknown>,
	messageId: string,
	result: Extract<TurnCostResult, { status: "ok" }>
): Promise<void> {
	const set: Record<string, string> = {
		"messages.$[m].stats.cost": result.cost,
		"messages.$[m].stats.costSource": "gateway",
	};
	if (result.currency) set["messages.$[m].stats.costCurrency"] = result.currency;
	await collections.conversations.updateOne(
		filter,
		{ $set: set },
		{ arrayFilters: [{ "m.id": messageId }] }
	);
}

/**
 * Fire-and-forget, after the turn's last write: never throws, never awaited on
 * the answer's path. A gateway without tags (404) or no gateway (503) is
 * "unavailable", and a cost still settling is "pending"; both keep the
 * in-stream sum, and the overlay asks again when it is opened.
 */
export function settleTurnCost(params: {
	conversationId: ObjectId;
	messageId: string;
	token: string | undefined;
	/** Test seam. */
	read?: typeof turnGatewayCost;
}): void {
	const { conversationId, messageId, token, read = turnGatewayCost } = params;
	if (!token) return;
	void (async () => {
		const result = await read(token, messageId);
		if (result.status !== "ok") return;
		await storeSettledCost({ _id: conversationId }, messageId, result);
	})().catch((err) => logger.warn({ err }, "turn cost settlement failed"));
}
