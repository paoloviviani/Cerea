/**
 * What the gateway charged for one assistant turn.
 *
 * Pystino settles a request's cost after the response has gone out, so it is
 * not in the stream. Instead every gateway call of a turn that is the turn's
 * own work carries `x-pystino-tag: turn:<conversation id>:<assistant message id>`, and the
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

/**
 * The tag of one turn: a gateway keeps at most 128 characters; this is 66. It names the
 * conversation too, because a message id is chosen by the client (C156): two conversations,
 * or two users sharing the deployment's key, can hold the same id, and the tag must still
 * be unique to the turn.
 */
export const turnTag = (conversationId: string, messageId: string): string =>
	`turn:${conversationId}:${messageId}`;

/** The tag turns carried before ids were client-chosen (C156): the message id alone. */
export const legacyTurnTag = (messageId: string): string => `turn:${messageId}`;

/** The header to stamp on a gateway call of this turn; nothing when the turn has no ids. */
export function turnTagHeader(
	messageId: string | undefined,
	conversationId: { toString(): string } | string | undefined
): Record<string, string> {
	return messageId && conversationId
		? { [USAGE_TAG_HEADER]: turnTag(conversationId.toString(), messageId) }
		: {};
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
	options: {
		/** The conversation the message is in: part of the tag. */
		conversationId: { toString(): string } | string;
		/**
		 * The message has `turnTagVersion: 2`, so it was tagged the scoped way only. One
		 * without it was made by older code, with a server-minted id, and may carry the
		 * legacy tag. No dates: the flag is stored on the message when it is created.
		 */
		scopedTag?: boolean;
		retryDelayMs?: number;
		sleep?: (ms: number) => Promise<void>;
	}
): Promise<TurnCostResult> {
	const { retryDelayMs = 2000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = options;
	const tag = turnTag(options.conversationId.toString(), messageId);
	// Only a message made before the scoped tag can have been tagged the old way.
	const legacy = options.scopedTag ? undefined : legacyTurnTag(messageId);
	try {
		const first = await readOnce(token, tag);
		if (first.status !== "pending") return first;
		if (legacy) {
			const old = await readOnce(token, legacy);
			if (old.status !== "pending") return old;
		}
		await sleep(retryDelayMs);
		const second = await readOnce(token, tag);
		if (second.status !== "pending" || !legacy) return second;
		return await readOnce(token, legacy);
	} catch (err) {
		// 404: a gateway without tags; 503: no gateway set up. Neither is news.
		if (!(err instanceof GatewayCallFailed && (err.status === 404 || err.status === 503))) {
			logger.warn({ err }, "turn cost read failed");
		}
		return { status: "unavailable" };
	}
}
