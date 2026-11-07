/**
 * What a failed gateway call means, in one place.
 *
 * The gateway answers HTTP 429 for two different things: a real rate limit
 * (wait, then try again) and a spent quota (`error.code === "quota_exceeded"`,
 * waiting does not help until the period resets or an administrator raises the
 * limit). Treating both as "rate limited" told users and models to wait for
 * something that would not pass.
 *
 * The body shape, from the gateway's `error_response`:
 *   { error: { message, type: "insufficient_quota", param: null, code: "quota_exceeded" } }
 * with the message "Quota exceeded. <scope> [per member|per user] limit of N
 * <metric> per <window> exceeded (current M)" and a `retry-after` header.
 * Optional fields arrive as null, so every read here tolerates null.
 */

import { m } from "$lib/paraglide/messages";

export type GatewayFailure =
	| {
			kind: "quota";
			/** The gateway's own wording, minus the "Quota exceeded." lead; null when it said none. */
			detail: string | null;
			/** Whose limit it was, when the message names it. */
			scope: "group" | "user" | "global" | "api_key" | null;
			/** Seconds until the window frees up, when the `retry-after` header was seen. */
			retryAfterSeconds: number | null;
			/** The limit, metric, window and spend parsed from the gateway's message; null when it did not match. */
			figures: QuotaFigures | null;
	  }
	| { kind: "rate_limit" }
	| { kind: "other" };

export type QuotaFigures = {
	/** "cost", "requests", "tokens", ... as the gateway names the metric. */
	metric: string;
	limit: number;
	current: number | null;
	/** "month", "day", "3600s", ... */
	window: string;
};

/**
 * "user limit of 0E-12 cost per month exceeded (current 0)": the figures are
 * Decimal strings, so a zero limit arrives in scientific notation. `Number()`
 * reads those; showing the raw text is what leaked "0E-12" to users.
 */
function parseFigures(detail: string): QuotaFigures | null {
	const match = /limit of (\S+) (\S+) per (.+?) exceeded(?: \(current (\S+?)\))?\.?$/.exec(detail);
	if (!match) return null;
	const limit = Number(match[1]);
	if (!Number.isFinite(limit)) return null;
	const current = match[4] === undefined ? null : Number(match[4]);
	return {
		metric: match[2] ?? "",
		limit,
		current: current !== null && Number.isFinite(current) ? current : null,
		window: match[3] ?? "",
	};
}

type Loose = {
	status?: unknown;
	code?: unknown;
	type?: unknown;
	message?: unknown;
	error?: unknown;
	headers?: unknown;
};

const asRecord = (v: unknown): Loose | null =>
	typeof v === "object" && v !== null ? (v as Loose) : null;

const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);

function headerValue(headers: unknown, name: string): string | null {
	if (!headers) return null;
	if (typeof (headers as Headers).get === "function") {
		return (headers as Headers).get(name) ?? null;
	}
	const rec = asRecord(headers) as Record<string, unknown> | null;
	return rec ? asString(rec[name]) : null;
}

/** The error object a failure carries, wherever the client put it. */
function bodies(err: Loose): Loose[] {
	const inner = asRecord(err.error);
	const nested = inner ? asRecord(inner.error) : null;
	return [err, inner, nested].filter((b): b is Loose => b !== null);
}

export function isQuotaError(err: unknown): boolean {
	return classifyGatewayError(err).kind === "quota";
}

export function classifyGatewayError(err: unknown): GatewayFailure {
	const e = asRecord(err);
	if (!e) return { kind: "other" };
	const found = bodies(e);
	const code = found.map((b) => asString(b.code)).find((c) => c !== null) ?? null;
	const type = found.map((b) => asString(b.type)).find((c) => c !== null) ?? null;
	const message = found.map((b) => asString(b.message)).find((c) => c !== null) ?? "";
	const status = typeof e.status === "number" ? e.status : null;

	if (
		code === "quota_exceeded" ||
		type === "insufficient_quota" ||
		(status === 429 && /^(\d{3}\s+)?Quota exceeded\./i.test(message))
	) {
		const stripped = message
			.replace(/^\d{3}\s+/, "")
			.replace(/^Quota exceeded\.?\s*/i, "")
			.trim();
		const scopeMatch = /^(global|group|user|api_key)\b/.exec(stripped);
		const retry = Number(headerValue(e.headers, "retry-after"));
		return {
			kind: "quota",
			detail: stripped || null,
			scope: (scopeMatch?.[1] as "group" | "user" | "global" | "api_key" | undefined) ?? null,
			retryAfterSeconds: Number.isFinite(retry) && retry > 0 ? retry : null,
			figures: parseFigures(stripped),
		};
	}
	if (status === 429 || /\b429\b/.test(String(err))) return { kind: "rate_limit" };
	return { kind: "other" };
}

/**
 * A sentence for the model: the quota is spent, so retrying or delegating again
 * changes nothing. English, because it is addressed to the model.
 */
export function quotaNoticeForModel(failure: Extract<GatewayFailure, { kind: "quota" }>): string {
	const whose =
		failure.scope === "group"
			? "the user's billing group has used up its usage quota"
			: failure.scope === "user"
				? "the user has used up their usage quota"
				: "the usage quota is used up";
	const detail = failure.detail ? ` (${failure.detail})` : "";
	return `Waiting will not help: ${whose}${detail}. Do not retry or delegate again in this turn; tell the user the quota is used up.`;
}

const PERIOD_ADJECTIVE: Record<string, string> = {
	month: "monthly",
	day: "daily",
	hour: "hourly",
	week: "weekly",
	year: "yearly",
};

function money(value: number, currency: string | undefined): string {
	if (currency && /^[A-Z]{3}$/.test(currency)) {
		try {
			return new Intl.NumberFormat("en", { style: "currency", currency }).format(value);
		} catch {
			// Unknown code: fall through to the plain number.
		}
	}
	return new Intl.NumberFormat("en", { maximumFractionDigits: 4 }).format(value);
}

export type QuotaMessageOptions = {
	/** The deployment's currency code, for a money limit. */
	currency?: string;
	/** Whether Settings → Usage exists to point to. */
	usageEnabled?: boolean;
	now?: Date;
};

/**
 * What the chat shows the user when the turn died on a spent quota, in one or
 * two plain sentences: whose allowance, how much, when it resets, who to ask.
 * The gateway's own wording never reaches the user; its figures are formatted.
 */
export function quotaMessageForUser(
	failure: Extract<GatewayFailure, { kind: "quota" }>,
	options: QuotaMessageOptions = {}
): string {
	const group = failure.scope === "group";
	const f = failure.figures;
	const parts: string[] = [];
	if (f) {
		const isMoney = f.metric === "cost";
		const amount = isMoney
			? money(f.limit, options.currency)
			: `${money(f.limit, undefined)} ${f.metric}`;
		const adjective = PERIOD_ADJECTIVE[f.window];
		const named = { period: adjective ?? "", window: f.window, amount };
		if (adjective) {
			parts.push(
				group
					? m["app.errors.quota_group_periodic"](named)
					: m["app.errors.quota_user_periodic"](named)
			);
		} else {
			parts.push(
				group ? m["app.errors.quota_group_per"](named) : m["app.errors.quota_user_per"](named)
			);
		}
	} else {
		parts.push(group ? m["app.errors.quota_group"]() : m["app.errors.quota_user"]());
	}
	// One short sentence and one way on: the Usage page where it exists, the
	// administrator where it does not.
	parts.push(
		options.usageEnabled ? m["app.errors.quota_see_usage"]() : m["app.errors.quota_ask_admin"]()
	);
	return parts.join(" ");
}
