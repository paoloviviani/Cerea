import { describe, expect, it } from "vitest";
import { deriveQuotaDisplay } from "./contextMeterQuotas";
import type { UsageSection } from "$lib/types/UsageReport";

const SECTIONS: UsageSection[] = [
	{
		title: "Quotas",
		entries: [
			{ label: "Requests", used: 5, limit: 10, unit: "requests", period: "per day" },
			{ label: "Tokens", used: 900, limit: 1000, unit: "tokens", period: "per month" },
		],
	},
	{
		title: "Spend",
		entries: [
			{ label: "You — requests", used: 5, unit: "requests", period: "per day" },
			{ label: "You — tokens", used: 900, unit: "tokens", period: "per day" },
		],
	},
];

describe("deriveQuotaDisplay", () => {
	it("hides the section before any report has loaded", () => {
		expect(deriveQuotaDisplay(null, null)).toEqual({ kind: "hidden" });
	});

	it("reports no quotas when the report has no entries at all", () => {
		expect(deriveQuotaDisplay([], null)).toEqual({ kind: "empty" });
	});

	it("reports no quotas when every entry is a plain stat with no limit", () => {
		const statsOnly: UsageSection[] = [SECTIONS[1]];
		expect(deriveQuotaDisplay(statsOnly, null)).toEqual({ kind: "empty" });
	});

	it("lists only the entries that carry a limit, dropping the per-entry consumption list", () => {
		const display = deriveQuotaDisplay(SECTIONS, null);
		expect(display).toEqual({ kind: "quotas", quotas: SECTIONS[0].entries });
		if (display.kind === "quotas") {
			expect(display.quotas.map((q) => q.label)).toEqual(["Requests", "Tokens"]);
			expect(display.quotas.every((q) => q.limit !== undefined)).toBe(true);
		}
	});

	it("reports a failed fetch as a quiet note, even with stale sections around", () => {
		expect(deriveQuotaDisplay(SECTIONS, "Could not load quotas.")).toEqual({
			kind: "error",
			message: "Could not load quotas.",
		});
	});

	it("surfaces a section-level error when it left no quotas behind", () => {
		const failed: UsageSection[] = [
			{ title: "Pystino usage", entries: [], error: "Usage is temporarily unavailable." },
		];
		expect(deriveQuotaDisplay(failed, null)).toEqual({
			kind: "error",
			message: "Usage is temporarily unavailable.",
		});
	});

	it("still shows quotas from a healthy section even if another section errored", () => {
		const mixed: UsageSection[] = [
			...SECTIONS,
			{ title: "Other provider", entries: [], error: "Other provider unavailable." },
		];
		const display = deriveQuotaDisplay(mixed, null);
		expect(display).toEqual({ kind: "quotas", quotas: SECTIONS[0].entries });
	});
});
