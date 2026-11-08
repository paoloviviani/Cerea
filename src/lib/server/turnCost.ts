/**
 * What the gateway charged for one assistant turn.
 *
 * Pystino settles a request's cost after the response has gone out, so it is
 * not in the stream. Instead every gateway call of a turn that is the turn's
 * own work carries `x-pystino-tag: turn:<assistant message id>`, and the
 * turn's cost is read afterwards from `GET /v1/pystino/usage/tags`, with the
 * signed-in user's own token (only their own requests can be read).
 *
 * Counted: the model's calls of the answer (the tool loop's rounds included)
 * and images the model generated during it. Not counted: the conversation's
 * title, which is made beside the answer and belongs to the conversation.
 *
 * Gateway-nulls rule: every field parsed from the gateway is `.nullish()`.
 */
import { z } from "zod";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";

export const USAGE_TAG_HEADER = "x-pystino-tag";

/** The tag of one turn: a gateway keeps at most 128 characters; this is 41. */
export const turnTag = (messageId: string): string => `turn:${messageId}`;

/** The header to stamp on a gateway call of this turn; nothing when the turn has no id. */
export function turnTagHeader(messageId: string | undefined): Record<string, string> {
	return messageId ? { [USAGE_TAG_HEADER]: turnTag(messageId) } : {};
}

const rowSchema = z.object({
	tag: z.string().nullish(),
	requests: z.number().nullish(),
	// Money is a decimal string on the wire; a number is tolerated.
	cost: z.union([z.string(), z.number()]).nullish(),
	currency: z.string().nullish(),
});

const responseSchema = z.object({ tags: z.array(rowSchema.nullish()).nullish() });

export type TurnCostResult =
	| { status: "ok"; cost: string; currency: string | null; requests: number }
	/** The gateway answered, and nothing has settled under the tag (yet). */
	| { status: "pending" }
	/** No gateway, a gateway without tags, or a failed read. */
	| { status: "unavailable" };

async function readOnce(token: string, tag: string): Promise<TurnCostResult> {
	const q = new URLSearchParams({ tag });
	const body = await gateway.get<unknown>(token, `pystino/usage/tags?${q}`, { timeoutMs: 8000 });
	const parsed = responseSchema.safeParse(body);
	if (!parsed.success) return { status: "unavailable" };
	const row = parsed.data.tags?.find((t) => t?.tag === tag);
	if (!row || row.cost === null || row.cost === undefined) return { status: "pending" };
	const cost = String(row.cost).trim();
	if (!/^\d+(\.\d+)?$/.test(cost)) return { status: "unavailable" };
	return {
		status: "ok",
		cost,
		currency: row.currency && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null,
		requests: typeof row.requests === "number" ? row.requests : 0,
	};
}

/**
 * The cost of a turn. Settlement can lag the last response by a moment, so a
 * "nothing settled" answer is asked once more after `retryDelayMs`.
 */
export async function turnGatewayCost(
	token: string,
	messageId: string,
	options: { retryDelayMs?: number; sleep?: (ms: number) => Promise<void> } = {}
): Promise<TurnCostResult> {
	const { retryDelayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
	const tag = turnTag(messageId);
	try {
		const first = await readOnce(token, tag);
		if (first.status !== "pending") return first;
		await sleep(retryDelayMs);
		return await readOnce(token, tag);
	} catch (err) {
		// 404: a gateway without tags; 503: no gateway set up. Neither is news.
		if (!(err instanceof GatewayCallFailed && (err.status === 404 || err.status === 503))) {
			logger.warn({ err }, "turn cost read failed");
		}
		return { status: "unavailable" };
	}
}
