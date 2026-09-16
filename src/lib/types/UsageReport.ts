/**
 * The wire shape of `GET /api/v2/usage`, shared between the server-side
 * `UsageProvider` interface (`$lib/server/usage/types.ts`, which re-exports
 * these) and the Usage & billing tab that renders them. Kept outside
 * `$lib/server` because the tab is a client component and needs the same
 * shapes to type its props.
 */

export type UsageScope = "user" | "group" | "global";

export interface UsageEntry {
	label: string;
	used: number;
	/** Present → the UI renders a progress bar. Absent → a plain stat. */
	limit?: number;
	unit: string;
	period?: string;
	scope?: UsageScope;
	/**
	 * The counter behind this entry could not be read (Pystino's
	 * `current_value: null`, meaning its store was unreachable). Rendered as
	 * "unknown", never as 0% — a bar reading empty and a bar nobody could read
	 * are different facts.
	 */
	unknown?: boolean;
}

export interface UsageSection {
	title: string;
	entries: UsageEntry[];
	link?: { label: string; href: string };
	/**
	 * Set instead of `entries` when this section's own source failed after
	 * the provider ran (a gateway error, mid-request). A thrown error would
	 * fail the whole tab for every other provider's section; this keeps the
	 * failure local to the section that actually broke.
	 */
	error?: string;
}

export interface UsageReport {
	sections: UsageSection[];
}
