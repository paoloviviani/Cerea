import { describe, expect, it } from "vitest";
import {
	formatCurrency,
	formatDate,
	formatDateTime,
	formatNumber,
	formatRelativeTime,
	intlLocale,
} from "./format";

describe("intlLocale", () => {
	it("hands Intl English for the pseudo-locale and the tag otherwise", () => {
		expect(intlLocale("en-XA")).toBe("en");
		expect(intlLocale("it")).toBe("it");
	});
});

describe("formatNumber", () => {
	it("follows the locale it is given", () => {
		expect(formatNumber(1234567.5, undefined, "en")).toBe("1,234,567.5");
		expect(formatNumber(1234567.5, undefined, "de")).toBe("1.234.567,5");
	});

	it("uses the active locale (English here) when none is given", () => {
		expect(formatNumber(1000)).toBe("1,000");
	});
});

describe("formatCurrency", () => {
	it("formats a currency code and falls back to the plain number for a bad one", () => {
		expect(formatCurrency(12.5, "EUR", "en")).toBe("€12.50");
		expect(formatCurrency(12.5, "not-a-currency", "en")).toBe("12.5");
	});
});

describe("formatDate and formatDateTime", () => {
	const when = new Date("2026-03-04T15:30:00Z");

	it("format in the given locale and time zone", () => {
		expect(formatDate(when, { dateStyle: "long", timeZone: "UTC" }, "en")).toBe("March 4, 2026");
		expect(formatDate(when, { dateStyle: "long", timeZone: "UTC" }, "de")).toBe("4. März 2026");
		expect(
			formatDateTime(when, { dateStyle: "short", timeStyle: "short", timeZone: "UTC" }, "en")
		).toBe("3/4/26, 3:30 PM");
	});

	it("accept an ISO string or a number, and show nothing for an invalid date", () => {
		expect(formatDate("2026-03-04T15:30:00Z", { dateStyle: "long", timeZone: "UTC" }, "en")).toBe(
			"March 4, 2026"
		);
		expect(formatDate(when.getTime(), { dateStyle: "long", timeZone: "UTC" }, "en")).toBe(
			"March 4, 2026"
		);
		expect(formatDate("not a date")).toBe("");
	});
});

describe("formatRelativeTime", () => {
	const now = new Date("2026-03-04T12:00:00Z");
	const ago = (ms: number) => new Date(now.getTime() - ms);
	const MIN = 60_000;
	const HOUR = 60 * MIN;
	const DAY = 24 * HOUR;

	it("picks the largest whole unit, rounding toward zero", () => {
		expect(formatRelativeTime(ago(30_000), now, "en")).toBe("30 seconds ago");
		expect(formatRelativeTime(ago(59 * MIN), now, "en")).toBe("59 minutes ago");
		expect(formatRelativeTime(ago(3 * HOUR + 40 * MIN), now, "en")).toBe("3 hours ago");
		expect(formatRelativeTime(ago(2 * DAY), now, "en")).toBe("2 days ago");
		expect(formatRelativeTime(ago(14 * DAY), now, "en")).toBe("2 weeks ago");
	});

	it("reads the future, and says 'now' and 'yesterday' where the language does", () => {
		expect(formatRelativeTime(new Date(now.getTime() + 2 * HOUR), now, "en")).toBe("in 2 hours");
		expect(formatRelativeTime(now, now, "en")).toBe("now");
		expect(formatRelativeTime(ago(DAY), now, "en")).toBe("yesterday");
	});

	it("follows the locale and shows nothing for an invalid date", () => {
		expect(formatRelativeTime(ago(3 * DAY), now, "de")).toBe("vor 3 Tagen");
		expect(formatRelativeTime("nope", now, "en")).toBe("");
	});
});
