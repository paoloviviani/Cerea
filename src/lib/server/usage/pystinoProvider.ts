/**
 * The Pystino `UsageProvider`: the caller's own quotas and spend, read
 * straight off the gateway with their own token (`gatewayServer.ts` — this
 * server acting as the signed-in person, never a deployment-wide credential,
 * for the same reason `projects.ts` retrieval does: seeing anything wider
 * than what this person may see would be a leak, not a convenience).
 *
 * One caller-scoped endpoint, no admin needed — the gateway filters it to what
 * the token may see (ADR 0074): `GET /v1/pystino/usage` returns the caller's
 * quota rules, own spend and per-group spend as a single document, so the tab
 * costs one round trip rather than three. Bearer-authenticated and off the
 * OpenAI-standard paths, so it works cross-origin (a token travels; a cookie
 * would not) — the reason this is not the browser calling `/api/me/*` directly.
 * Quota rules all render (ADR 0009: all must pass), never a single "binding" one.
 *
 * Personal figures only. The gateway document is the same one the console
 * sees, so it carries what the console may see — per-group spend
 * (`groups`) and rule counters that aggregate a group or the deployment —
 * and this mapping is where that stops: nothing that tells a person what a
 * group as a whole spent reaches `/api/v2/usage`. A rule of that kind is
 * still listed (it can refuse a turn, so it exists to the person), with its
 * period, but with no figure at all: `noFigures`. What the person is refused
 * by such a rule sees the gateway's own quota message in the chat, which
 * explains the refusal; this page is not the place to hint at the total.
 */

import { config } from "$lib/server/config";
import { gateway } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";
import type { UsageContext, UsageEntry, UsageProvider, UsageReport, UsageSection } from "./types";

/** The Pystino console, same origin (the OAuth flow already routes through `/console/login`). */
const CONSOLE_PATH = "/console";

/** The single `GET /v1/pystino/usage` document (ADR 0074), minus what this
 * application must not forward: the document also carries
 * `groups: Record<string, UsageSummaryResponse>` — how much each of the
 * person's groups spent, a valid answer for the console and for
 * administrators, but a group spending figure all the same, so it is not
 * typed here and never mapped out. */
interface PystinoUsageBundle {
	limits: MyLimitResponse[];
	/** A gateway `Optional`; treating null as "nothing personal to show". */
	usage?: UsageSummaryResponse | null;
}

interface MyLimitResponse {
	id: string;
	name: string;
	scope: "global" | "group" | "user";
	metric: string;
	window_label: string;
	/** Decimal string, e.g. "1000.00". */
	limit_value: string;
	/** Decimal string, or null when the counter store was unreachable. */
	current_value: string | null;
	notification_thresholds: number[];
	/**
	 * ADR 0098, additive: "each_member" means this entry is the caller's own
	 * share of a group budget, not the group's total. Absent on an older
	 * gateway, which only ever sent aggregate rules.
	 */
	applies_to?: "aggregate" | "each_member";
}

interface UsageSummaryResponse {
	window_seconds: number;
	requests: number;
	total_tokens: number;
	/** Decimal string. */
	cost: string;
	currency: string;
	estimated_requests: number;
}

function windowLabel(seconds: number): string {
	if (seconds > 0 && seconds % 86400 === 0) {
		const days = seconds / 86400;
		return days === 1 ? "per day" : `per ${days} days`;
	}
	if (seconds > 0 && seconds % 3600 === 0) {
		const hours = seconds / 3600;
		return hours === 1 ? "per hour" : `per ${hours} hours`;
	}
	return `per ${seconds}s`;
}

/** ADR 0098: `each_member` is the caller's own share of a group budget —
 * the one rule kind whose reported consumption is personal. Everything else
 * on a `group` scope (and the whole of a `global` scope) aggregates higher
 * than this person, so no figure of it may leave the server. */
function isSharedRule(limit: MyLimitResponse): boolean {
	return (
		limit.scope === "global" || (limit.scope === "group" && limit.applies_to !== "each_member")
	);
}

/** The shared-budget entry: it says the limit exists and its period, and
 * carries no number — not the used amount (the group's or deployment's
 * total), not the limit, not a percentage, not a remainder. */
function sharedLimitEntry(limit: MyLimitResponse): UsageEntry {
	return {
		label: [
			limit.name,
			limit.window_label,
			limit.scope === "group" ? "shared by your group" : "shared by everyone",
		]
			.filter(Boolean)
			.join(" · "),
		unit: limit.metric,
		scope: limit.scope,
		noFigures: true,
	};
}

function limitEntry(limit: MyLimitResponse): UsageEntry {
	if (isSharedRule(limit)) return sharedLimitEntry(limit);

	const unknown = limit.current_value === null;
	const entry: UsageEntry = {
		label: [
			limit.name,
			limit.window_label,
			// Say which kind of budget this bar is: a per-member rule sits
			// beside the group's aggregate rule with the same name and window,
			// and without the marker one of the two numbers reads as a bug.
			limit.applies_to === "each_member" ? "per member" : null,
		]
			.filter(Boolean)
			.join(" · "),
		// A number is still required when unknown; the UI must key off
		// `unknown`, not read this as a real 0%.
		used: unknown ? 0 : Number(limit.current_value),
		limit: Number(limit.limit_value),
		unit: limit.metric,
		scope: limit.scope,
	};
	if (unknown) entry.unknown = true;
	return entry;
}

/** The three stats one `/me/usage*` summary contributes, all sharing its window. */
function summaryEntries(
	label: string,
	summary: UsageSummaryResponse,
	scope: UsageEntry["scope"]
): UsageEntry[] {
	const period = windowLabel(summary.window_seconds);
	return [
		{ label: `${label} — requests`, used: summary.requests, unit: "requests", period, scope },
		{ label: `${label} — tokens`, used: summary.total_tokens, unit: "tokens", period, scope },
		{
			label: `${label} — spend`,
			used: Number(summary.cost),
			unit: summary.currency,
			period,
			scope,
		},
	];
}

export const pystinoUsageProvider: UsageProvider = {
	id: "pystino",

	isEnabled() {
		return config.CHAT_USAGE_ENABLED === "true" && !!config.OPENAI_BASE_URL;
	},

	async getReport(ctx: UsageContext): Promise<UsageReport> {
		const token = ctx.locals.token;
		if (!token) {
			// Signed in without an OIDC session — same case the gateway forwarder
			// names explicitly. Nothing to retry with a service credential: these
			// endpoints only ever answer for the caller who asks.
			return {
				sections: [
					{
						title: "Pystino usage",
						entries: [],
						error: "Usage needs an OIDC session. Sign out and back in through the provider.",
					},
				],
			};
		}

		try {
			const bundle = await gateway.get<PystinoUsageBundle>(token, "pystino/usage");

			const quotas: UsageSection = {
				title: "Quotas",
				entries: (bundle.limits ?? []).map(limitEntry),
			};

			const spend: UsageSection = {
				title: "Your spending",
				entries: bundle.usage ? summaryEntries("You", bundle.usage, "user") : [],
				link: { label: "Manage in the Pystino console", href: CONSOLE_PATH },
			};

			return { sections: [quotas, spend] };
		} catch (err) {
			// Retrieval never fails a turn (see projects.ts); the same judgement
			// applies here — a quota tab that cannot reach the gateway is a
			// reason to say so, not a reason to break Settings.
			logger.error({ err }, "pystino usage provider failed");
			return {
				sections: [
					{
						title: "Pystino usage",
						entries: [],
						error: "Usage is temporarily unavailable.",
						link: { label: "Open the Pystino console", href: CONSOLE_PATH },
					},
				],
			};
		}
	},
};
