/**
 * What the gateway metered for a coding-agent session (ADR 0108 item 2b).
 *
 * galopin's shim stamps every LLM request it forwards with `x-pystino-tag:
 * <session id>` (the top-level session: a subagent's calls count toward its
 * parent), and Pystino stores it on the usage row. This asks Pystino for the
 * signed-in user's own totals under that tag, with that user's own token, so
 * cost and tokens do not depend on the engine's counters and are the figures
 * the gateway billed. Nothing here is a spend authority beyond that: it is
 * "as metered by the gateway".
 *
 * A gateway that predates tags answers 404, and a session galopin never
 * tagged has no rows: both read as "no figures" and the meter falls back to
 * the engine's own counters.
 */

import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";

export interface GatewayUsageTotals {
	requests: number;
	promptTokens: number;
	completionTokens: number;
	cachedPromptTokens: number;
	/** A decimal string in `currency`, as the gateway sent it. */
	cost: string;
}

export interface SessionGatewayUsage {
	currency: string | null;
	session: GatewayUsageTotals | null;
	/** The window the caller named (a turn), when it named one. */
	window: GatewayUsageTotals | null;
}

interface TagUsageRow {
	tag: string;
	requests: number;
	prompt_tokens: number;
	completion_tokens: number;
	cached_prompt_tokens: number;
	cost: string;
	currency: string;
}

interface TagUsageResponse {
	tags?: TagUsageRow[] | null;
}

/** The longest tag the gateway keeps; a longer id has no rows to find. */
const MAX_TAG = 128;

function totals(row: TagUsageRow): GatewayUsageTotals {
	return {
		requests: row.requests,
		promptTokens: row.prompt_tokens,
		completionTokens: row.completion_tokens,
		cachedPromptTokens: row.cached_prompt_tokens,
		cost: row.cost,
	};
}

async function read(
	token: string,
	tag: string,
	range: { since?: Date; until?: Date } = {}
): Promise<TagUsageRow | null> {
	const q = new URLSearchParams({ tag });
	if (range.since) q.set("since", range.since.toISOString());
	if (range.until) q.set("until", range.until.toISOString());
	const body = await gateway.get<TagUsageResponse>(token, `pystino/usage/tags?${q}`, {
		timeoutMs: 8000,
	});
	return body.tags?.find((t) => t.tag === tag) ?? null;
}

/**
 * Session totals, and totals for a window when `window` is given. The window
 * is two instants on the gateway's own clock (the caller turned durations
 * into instants on this server's), so a browser's clock never enters.
 * Returns null when the gateway has nothing to say (too old, unreachable).
 */
export async function sessionGatewayUsage(
	token: string,
	sessionId: string,
	window?: { since: Date; until?: Date }
): Promise<SessionGatewayUsage | null> {
	if (sessionId.length > MAX_TAG) return null;
	try {
		const [whole, part] = await Promise.all([
			read(token, sessionId),
			window ? read(token, sessionId, window) : Promise.resolve(null),
		]);
		return {
			currency: whole?.currency ?? part?.currency ?? null,
			session: whole ? totals(whole) : null,
			window: part ? totals(part) : null,
		};
	} catch (err) {
		// 404: a gateway without tags; 4xx/5xx/timeouts: not worth failing a
		// panel over. The engine's own counters still show.
		if (!(err instanceof GatewayCallFailed && err.status === 404)) {
			logger.warn({ err }, "session gateway usage failed");
		}
		return null;
	}
}
