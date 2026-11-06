/**
 * What the gateway metered for a coding session, as the context meter shows it
 * (ADR 0108 item 2b). The figures come from Pystino's usage rows for the
 * requests galopin's proxy forwarded, so they are the same for every engine and
 * are the cost the user is charged; the engine's own counters only ever drive
 * the context ring (how full the window is), never money.
 */
import { formatNumber } from "$lib/i18n/format";

export interface GatewayUsageTotals {
	requests: number;
	promptTokens: number;
	completionTokens: number;
	cachedPromptTokens: number;
	/** A decimal string in `currency`. */
	cost: string;
}

export interface GatewayUsage {
	currency: string | null;
	session: GatewayUsageTotals | null;
	/** The latest turn this page saw, when it saw one. */
	turn: GatewayUsageTotals | null;
}

/** The server's answer: `available: false` for a gateway without tags, a user
 * without an OIDC session, or a failed read. */
export type GatewayUsageResponse =
	| { available: false }
	| {
			available: true;
			currency: string | null;
			session: GatewayUsageTotals | null;
			window: GatewayUsageTotals | null;
	  };

export function toGatewayUsage(res: GatewayUsageResponse | null): GatewayUsage | null {
	if (!res || !res.available) return null;
	if (!res.session && !res.window) return null;
	return { currency: res.currency, session: res.session, turn: res.window };
}

/** Prompt plus completion: the number the meter falls back to when the engine
 * reports no context figure of its own. */
export function totalTokens(t: GatewayUsageTotals): number {
	return t.promptTokens + t.completionTokens;
}

/** A cost in its currency. Cheap turns cost fractions of a cent, so up to four
 * decimals are kept where two would read as "0.00". */
export function formatCost(cost: string, currency: string | null): string {
	const value = Number(cost);
	if (!Number.isFinite(value)) return cost;
	const digits = { minimumFractionDigits: 2, maximumFractionDigits: 4 };
	try {
		return formatNumber(value, currency ? { style: "currency", currency, ...digits } : digits);
	} catch {
		// An unknown currency code: the number and the code, never a throw.
		return `${formatNumber(value, digits)} ${currency ?? ""}`.trim();
	}
}

/** A token count in thousands once it is large, as the meter's label shows it. */
export function formatTokens(n: number): string {
	if (n >= 1000) return `${formatNumber(Math.round(n / 100) / 10)}k`;
	return formatNumber(n);
}

/**
 * Where a turn began and ended, as this page saw it: the rising and falling
 * edges of "running". Durations rather than instants when asked of the server
 * (`ageOf`), so a browser clock that disagrees with the gateway's never shifts
 * the window.
 */
export interface TurnSpan {
	startedAt: number;
	endedAt: number | null;
}

/** The page learns a turn began a moment after its first model call may have
 * been made, so the window opens this much earlier. */
export const TURN_LEAD_MS = 3000;

export function turnQuery(span: TurnSpan | null, now: number): string {
	if (!span) return "";
	const q = new URLSearchParams({
		sinceAgoMs: String(Math.max(0, Math.round(now - span.startedAt)) + TURN_LEAD_MS),
	});
	if (span.endedAt !== null)
		q.set("untilAgoMs", String(Math.max(0, Math.round(now - span.endedAt))));
	return `&${q}`;
}
