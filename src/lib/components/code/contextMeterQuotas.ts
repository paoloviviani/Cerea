/**
 * Pure derivation for the context ring popup's Quotas section (queued item,
 * `reports/2026-09-24-thin-agent-progress.md`). Kept out of `ContextMeter.svelte`
 * so the three states — nothing to show, a fetch failure, and a report with
 * sections — are testable without mounting the component.
 *
 * "No quotas" and "fetch failed" render differently on purpose: an empty
 * report is a clean, silent hide (matching the Settings → Usage page), while
 * a failure is the one case worth telling the person about, in one quiet
 * line, without breaking the meter itself.
 */

import type { UsageSection } from "$lib/types/UsageReport";

export type QuotaDisplay =
	| { kind: "hidden" }
	| { kind: "error"; message: string }
	| { kind: "sections"; sections: UsageSection[] };

export function deriveQuotaDisplay(
	sections: UsageSection[] | null,
	error: string | null
): QuotaDisplay {
	if (error) return { kind: "error", message: error };
	if (!sections || sections.length === 0) return { kind: "hidden" };
	return { kind: "sections", sections };
}
