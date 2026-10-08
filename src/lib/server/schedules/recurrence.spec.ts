import { describe, expect, it } from "vitest";
import {
	describeRecurrence,
	intervalAfter,
	isValidTimezone,
	nextOccurrence,
	nextOccurrences,
	validateRecurrence,
} from "./recurrence";
import type { Recurrence } from "$lib/types/Schedule";

const ANCHOR = new Date("2026-01-01T00:00:00Z");
const iso = (d: Date | null) => d?.toISOString();

describe("validateRecurrence", () => {
	const check = (input: unknown, tz = "Europe/Rome") =>
		validateRecurrence(input, tz, new Date("2026-06-01T00:00:00Z"));

	it("accepts the presets", () => {
		expect(check({ type: "hours", every: 1 }).ok).toBe(true);
		expect(check({ type: "daily", at: "09:00" }).ok).toBe(true);
		expect(check({ type: "weekdays", at: "23:59" }).ok).toBe(true);
		expect(check({ type: "weekly", day: 0, at: "00:00" }).ok).toBe(true);
	});

	it("refuses a bad hour count, time or day", () => {
		expect(check({ type: "hours", every: 0 }).ok).toBe(false);
		expect(check({ type: "hours", every: 1.5 }).ok).toBe(false);
		expect(check({ type: "hours", every: 24 * 30 + 1 }).ok).toBe(false);
		expect(check({ type: "daily", at: "25:00" }).ok).toBe(false);
		expect(check({ type: "daily", at: "9:00" }).ok).toBe(false);
		expect(check({ type: "weekly", day: 7, at: "09:00" }).ok).toBe(false);
		expect(check({ type: "nonsense" }).ok).toBe(false);
		expect(check(null).ok).toBe(false);
	});

	describe("the 15-minute floor", () => {
		it("accepts a cron expression exactly 15 minutes apart", () => {
			expect(check({ type: "cron", expr: "*/15 * * * *" }).ok).toBe(true);
		});
		it("refuses anything faster", () => {
			for (const expr of ["* * * * *", "*/5 * * * *", "*/14 * * * *", "0,10 9 * * *"]) {
				const result = check({ type: "cron", expr });
				expect(result.ok, expr).toBe(false);
				if (!result.ok) expect(result.error).toMatch(/15 minutes/);
			}
		});
		it("finds a short gap between two times on the same day", () => {
			// 09:00 and 09:10 on the 1st only: a month between days, ten minutes within one.
			expect(check({ type: "cron", expr: "0,10 9 1 * *" }).ok).toBe(false);
		});
		it("refuses a seconds field", () => {
			const result = check({ type: "cron", expr: "*/30 * * * * *" });
			expect(result.ok).toBe(false);
			expect(check({ type: "cron", expr: "0 0 9 * * *" }).ok).toBe(false);
		});
		it("refuses an expression that never fires, and one that does not parse", () => {
			expect(check({ type: "cron", expr: "0 0 31 2 *" }).ok).toBe(false);
			expect(check({ type: "cron", expr: "nope nope nope nope nope" }).ok).toBe(false);
			expect(check({ type: "cron", expr: "" }).ok).toBe(false);
		});
		it("takes a nickname", () => {
			expect(check({ type: "cron", expr: "@hourly" }).ok).toBe(true);
		});
	});
});

describe("isValidTimezone", () => {
	it("knows IANA zones", () => {
		expect(isValidTimezone("Europe/Rome")).toBe(true);
		expect(isValidTimezone("UTC")).toBe(true);
		expect(isValidTimezone("Mars/Olympus")).toBe(false);
		expect(isValidTimezone("")).toBe(false);
	});
});

describe("nextOccurrence", () => {
	it("daily is wall-clock in the zone", () => {
		const daily: Recurrence = { type: "daily", at: "09:00" };
		// 09:00 CET (UTC+1) in winter, CEST (UTC+2) in summer.
		expect(
			iso(nextOccurrence(daily, "Europe/Rome", new Date("2026-01-10T00:00:00Z"), ANCHOR))
		).toBe("2026-01-10T08:00:00.000Z");
		expect(
			iso(nextOccurrence(daily, "Europe/Rome", new Date("2026-07-10T00:00:00Z"), ANCHOR))
		).toBe("2026-07-10T07:00:00.000Z");
	});

	it("is strictly after the instant it is asked from", () => {
		const daily: Recurrence = { type: "daily", at: "09:00" };
		const at = new Date("2026-01-10T08:00:00Z");
		expect(iso(nextOccurrence(daily, "Europe/Rome", at, ANCHOR))).toBe("2026-01-11T08:00:00.000Z");
	});

	it("weekdays skips the weekend", () => {
		const weekdays: Recurrence = { type: "weekdays", at: "09:00" };
		// Friday 2026-01-09 09:00 UTC, after which the next is Monday the 12th.
		expect(iso(nextOccurrence(weekdays, "UTC", new Date("2026-01-09T09:00:00Z"), ANCHOR))).toBe(
			"2026-01-12T09:00:00.000Z"
		);
	});

	it("weekly lands on its day", () => {
		const monday: Recurrence = { type: "weekly", day: 1, at: "07:30" };
		expect(iso(nextOccurrence(monday, "UTC", new Date("2026-01-09T00:00:00Z"), ANCHOR))).toBe(
			"2026-01-12T07:30:00.000Z"
		);
	});

	it("every N hours counts elapsed hours from the anchor, not clock hours", () => {
		const every4: Recurrence = { type: "hours", every: 4 };
		expect(iso(nextOccurrence(every4, "UTC", new Date("2026-01-01T00:00:00Z"), ANCHOR))).toBe(
			"2026-01-01T04:00:00.000Z"
		);
		expect(iso(nextOccurrence(every4, "UTC", new Date("2026-01-01T05:30:00Z"), ANCHOR))).toBe(
			"2026-01-01T08:00:00.000Z"
		);
		// Before the anchor: the first run is one period after it.
		expect(iso(nextOccurrence(every4, "UTC", new Date("2025-12-01T00:00:00Z"), ANCHOR))).toBe(
			"2026-01-01T04:00:00.000Z"
		);
	});

	it("every N hours does not bend for DST", () => {
		const every3: Recurrence = { type: "hours", every: 3 };
		const anchor = new Date("2026-03-28T22:00:00Z");
		const runs = nextOccurrences(every3, "Europe/Rome", anchor, anchor, 4);
		expect(runs.map((d) => d.getTime() - anchor.getTime())).toEqual([
			3 * 3600e3,
			6 * 3600e3,
			9 * 3600e3,
			12 * 3600e3,
		]);
	});

	describe("DST", () => {
		const at0230: Recurrence = { type: "daily", at: "02:30" };

		it("a time the clock skips runs once, at the first instant that exists", () => {
			// Rome, spring forward on 2026-03-29: 02:00 -> 03:00, so 02:30 does not exist.
			const runs = nextOccurrences(
				at0230,
				"Europe/Rome",
				new Date("2026-03-27T12:00:00Z"),
				ANCHOR,
				4
			).map((d) => d.toISOString());
			expect(runs).toEqual([
				"2026-03-28T01:30:00.000Z", // 02:30 CET
				"2026-03-29T01:30:00.000Z", // 03:30 CEST: the day it was skipped, still once
				"2026-03-30T00:30:00.000Z", // 02:30 CEST
				"2026-03-31T00:30:00.000Z",
			]);
		});

		it("a time the clock repeats runs once, at the first of the two", () => {
			// Rome, fall back on 2026-10-25: 03:00 CEST -> 02:00 CET, so 02:30 happens twice.
			const runs = nextOccurrences(
				at0230,
				"Europe/Rome",
				new Date("2026-10-23T12:00:00Z"),
				ANCHOR,
				3
			).map((d) => d.toISOString());
			expect(runs).toEqual([
				"2026-10-24T00:30:00.000Z",
				"2026-10-25T00:30:00.000Z", // 02:30 CEST, the first; not also 01:30Z
				"2026-10-26T01:30:00.000Z", // 02:30 CET
			]);
		});

		it("is right in a zone west of UTC as well", () => {
			const runs = nextOccurrences(
				at0230,
				"America/New_York",
				new Date("2026-03-06T12:00:00Z"),
				ANCHOR,
				3
			).map((d) => d.toISOString());
			expect(runs).toEqual([
				"2026-03-07T07:30:00.000Z",
				"2026-03-08T07:30:00.000Z", // 03:30 EDT: 02:30 was skipped
				"2026-03-09T06:30:00.000Z",
			]);
		});

		it("an hourly cron across fall-back runs each wall-clock hour once", () => {
			const hourly: Recurrence = { type: "cron", expr: "0 * * * *" };
			const runs = nextOccurrences(
				hourly,
				"America/New_York",
				new Date("2026-11-01T04:30:00Z"),
				ANCHOR,
				3
			).map((d) => d.toISOString());
			expect(runs).toEqual([
				"2026-11-01T05:00:00.000Z", // 01:00 EDT
				"2026-11-01T07:00:00.000Z", // 02:00 EST; the repeated 01:00 EST is not a second run
				"2026-11-01T08:00:00.000Z",
			]);
		});
	});
});

describe("intervalAfter", () => {
	it("is the gap to the following occurrence", () => {
		const every2: Recurrence = { type: "hours", every: 2 };
		expect(intervalAfter(every2, "UTC", new Date("2026-01-01T02:00:00Z"), ANCHOR)).toBe(2 * 3600e3);
		const daily: Recurrence = { type: "daily", at: "09:00" };
		expect(intervalAfter(daily, "UTC", new Date("2026-01-01T09:00:00Z"), ANCHOR)).toBe(24 * 3600e3);
	});
});

describe("describeRecurrence", () => {
	it("reads plainly", () => {
		expect(describeRecurrence({ type: "hours", every: 1 })).toBe("Every hour");
		expect(describeRecurrence({ type: "hours", every: 6 })).toBe("Every 6 hours");
		expect(describeRecurrence({ type: "weekly", day: 1, at: "08:15" })).toBe(
			"Every Monday at 08:15"
		);
		expect(describeRecurrence({ type: "weekdays", at: "09:00" })).toBe("Weekdays at 09:00");
	});
});
