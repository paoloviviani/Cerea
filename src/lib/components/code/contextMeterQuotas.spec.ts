import { describe, expect, it } from "vitest";
import { deriveQuotaDisplay } from "./contextMeterQuotas";
import type { UsageSection } from "$lib/types/UsageReport";

const SECTIONS: UsageSection[] = [
	{ title: "You — this month", entries: [{ label: "Tokens", used: 100, unit: "tokens" }] },
	{ title: "Team", entries: [{ label: "Requests", used: 5, limit: 10, unit: "requests" }] },
];

describe("deriveQuotaDisplay", () => {
	it("hides the section when the gateway reports no quotas", () => {
		expect(deriveQuotaDisplay([], null)).toEqual({ kind: "hidden" });
	});

	it("hides the section before any report has loaded", () => {
		expect(deriveQuotaDisplay(null, null)).toEqual({ kind: "hidden" });
	});

	it("preserves the report's own section order", () => {
		const display = deriveQuotaDisplay(SECTIONS, null);
		expect(display).toEqual({ kind: "sections", sections: SECTIONS });
		if (display.kind === "sections") {
			expect(display.sections.map((s) => s.title)).toEqual(["You — this month", "Team"]);
		}
	});

	it("reports a failed fetch as a quiet note, even with stale sections around", () => {
		expect(deriveQuotaDisplay(SECTIONS, "Could not load quotas.")).toEqual({
			kind: "error",
			message: "Could not load quotas.",
		});
	});
});
