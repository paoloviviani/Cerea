import type { UsageEntry, UsageReport } from "$lib/types/UsageReport";

/**
 * What the user menu's small quota summary shows, picked from the same report
 * Settings → Usage & billing renders (`GET /api/v2/usage`).
 *
 * The report can carry many entries (requests, tokens, money; per user, per
 * group). The menu has room for one: the figure a user is most likely to run
 * out of. A limit beats a bare spend; money beats counts; the user's own entry
 * beats a shared one. Shared budgets (`noFigures`) and unreadable counters
 * (`unknown`) never qualify: there is no figure to show.
 */
export type QuotaSummary =
	| {
			kind: "limit";
			entry: UsageEntry;
			used: number;
			limit: number;
			/** 0..100 */
			percent: number;
			/** From 80% of the limit on: the bar turns amber. */
			near: boolean;
	  }
	| { kind: "spend"; entry: UsageEntry; used: number };

export const NEAR_LIMIT_PERCENT = 80;

const isCurrency = (entry: UsageEntry) => /^[A-Z]{3}$/.test(entry.unit);

function rank(entry: UsageEntry): number {
	return (isCurrency(entry) ? 0 : 2) + (entry.scope === "user" || !entry.scope ? 0 : 1);
}

export function summariseQuota(report: UsageReport | null | undefined): QuotaSummary | null {
	const entries = (report?.sections ?? [])
		.filter((section) => !section.error)
		.flatMap((section) => section.entries ?? [])
		.filter((entry) => !entry.noFigures && !entry.unknown && entry.used !== undefined);
	const byRank = (a: UsageEntry, b: UsageEntry) => rank(a) - rank(b);

	const limited = entries
		.filter((entry) => entry.limit !== undefined && entry.limit > 0)
		.sort(byRank)[0];
	if (limited) {
		const used = limited.used ?? 0;
		const limit = limited.limit ?? 0;
		const percent = Math.min(100, (used / limit) * 100);
		return {
			kind: "limit",
			entry: limited,
			used,
			limit,
			percent,
			near: percent >= NEAR_LIMIT_PERCENT,
		};
	}
	// No limit anywhere: spend, which only means something in money.
	const spent = entries
		.filter((entry) => entry.limit === undefined && isCurrency(entry))
		.sort(byRank)[0];
	return spent ? { kind: "spend", entry: spent, used: spent.used ?? 0 } : null;
}
