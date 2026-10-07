import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./relativeTime";

const now = new Date("2026-10-07T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("formatRelativeTime", () => {
	it("says just now under a minute, and for a clock that is slightly ahead", () => {
		expect(formatRelativeTime(ago(5), now, "en")).toBe("just now");
		expect(formatRelativeTime(ago(-30), now, "en")).toBe("just now");
	});

	it("uses the largest unit that fits", () => {
		expect(formatRelativeTime(ago(5 * 60), now, "en")).toBe("5 minutes ago");
		expect(formatRelativeTime(ago(3 * 3600), now, "en")).toBe("3 hours ago");
		expect(formatRelativeTime(ago(24 * 3600), now, "en")).toBe("yesterday");
		expect(formatRelativeTime(ago(3 * 24 * 3600), now, "en")).toBe("3 days ago");
		expect(formatRelativeTime(ago(15 * 24 * 3600), now, "en")).toBe("2 weeks ago");
		expect(formatRelativeTime(ago(70 * 24 * 3600), now, "en")).toBe("2 months ago");
		expect(formatRelativeTime(ago(400 * 24 * 3600), now, "en")).toBe("last year");
	});

	it("accepts strings and returns nothing for an unreadable date", () => {
		expect(formatRelativeTime("2026-10-07T09:00:00Z", now, "en")).toBe("3 hours ago");
		expect(formatRelativeTime("not a date", now, "en")).toBe("");
	});
});
