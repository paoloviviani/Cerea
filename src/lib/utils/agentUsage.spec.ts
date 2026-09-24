import { describe, expect, it } from "vitest";
import { keepReportedUsage } from "./agentUsage";

describe("keepReportedUsage", () => {
	const reported = { used: 400, max: 1000, input: 300, output: 100 };

	it("takes a real report", () => {
		expect(keepReportedUsage(null, reported)).toBe(reported);
		const later = { used: 900, max: 1000 };
		expect(keepReportedUsage(reported, later)).toBe(later);
	});

	it("keeps the last report while a new message has not reported yet", () => {
		expect(keepReportedUsage(reported, { used: 0, max: 1000, input: 0, output: 0 })).toBe(reported);
		expect(keepReportedUsage(reported, {})).toBe(reported);
	});

	it("shows nothing rather than a fake 0 before any report", () => {
		expect(keepReportedUsage(null, { used: 0 })).toBeNull();
	});
});
