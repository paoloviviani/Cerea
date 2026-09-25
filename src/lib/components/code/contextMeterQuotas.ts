/**
 * Pure derivation for the context ring popup's Quotas section (queued item,
 * `reports/2026-09-24-thin-agent-progress.md`). Kept out of `ContextMeter.svelte`
 * so the four states — nothing to show yet, a fetch failure, no quotas, and
 * a flat list of quotas — are testable without mounting the component.
 *
 * This popup shows only entries that carry a `limit` — the quotas the person
 * is actually subject to — never the per-entry consumption list (Pystino's
 * "Spend" section) that the Settings → Usage page still shows in full.
 * `entry.limit === undefined` is exactly how `UsageBar` itself tells a quota
 * bar from a plain stat row, so filtering on it here keeps the two views
 * consistent without a second flag.
 *
 * "No quotas" and "fetch failed" render differently on purpose: no quotas is
 * a quiet, expected fact (shown as its own muted line, per the brief), while
 * a failure is the one case worth calling out, without breaking the meter
 * itself. A section-level `error` (the provider reached the gateway but that
 * request failed) is treated the same as a fetch failure when it left no
 * quotas behind; if some quotas did come back, they still render.
 */

import type { UsageEntry, UsageSection } from "$lib/types/UsageReport";

export type QuotaDisplay =
	| { kind: "hidden" }
	| { kind: "error"; message: string }
	| { kind: "empty" }
	| { kind: "quotas"; quotas: UsageEntry[] };

export function deriveQuotaDisplay(
	sections: UsageSection[] | null,
	error: string | null
): QuotaDisplay {
	if (error) return { kind: "error", message: error };
	if (sections === null) return { kind: "hidden" };

	// Flattened across sections, so a quota keeps its section's name when
	// more than one section has quotas: a personal and a group budget can
	// share a label ("Monthly spend"), and without it they read the same.
	const withQuotas = sections
		.map((section) => ({
			title: section.title,
			quotas: section.entries.filter((e) => e.limit !== undefined),
		}))
		.filter((section) => section.quotas.length > 0);
	const qualify = withQuotas.length > 1;
	const quotas = withQuotas.flatMap((section) =>
		section.quotas.map((e) => (qualify ? { ...e, label: `${section.title} · ${e.label}` } : e))
	);
	if (quotas.length > 0) return { kind: "quotas", quotas };

	const sectionError = sections.find((section) => section.error)?.error;
	if (sectionError) return { kind: "error", message: sectionError };

	return { kind: "empty" };
}
