import { afterEach, describe, expect, it, vi } from "vitest";
import { groupConversations } from "./conversationGroups";

const original = process.env.TZ;
afterEach(() => {
	process.env.TZ = original;
	vi.useRealTimers();
});

/** A chat last active at a local wall-clock time. */
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi);
const chat = (id: string, lastActivityAt: Date, updatedAt = lastActivityAt) => ({
	id,
	updatedAt,
	lastActivityAt,
});
const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe.each(["UTC", "America/Los_Angeles", "Asia/Tokyo"])("grouping in %s", (tz) => {
	it("a chat from 23:30 yesterday is not Today at 08:00; one from 00:05 today is", () => {
		process.env.TZ = tz;
		vi.useFakeTimers();
		vi.setSystemTime(at(2026, 11, 8, 8, 0));
		const groups = groupConversations([
			chat("late-yesterday", at(2026, 11, 7, 23, 30)),
			chat("just-after-midnight", at(2026, 11, 8, 0, 5)),
			chat("this-morning", at(2026, 11, 8, 7, 59)),
		]);
		expect(ids(groups.today)).toEqual(["just-after-midnight", "this-morning"]);
		expect(ids(groups.week)).toEqual(["late-yesterday"]);
	});

	it("the week is the seven calendar days before today; then the month; then older", () => {
		process.env.TZ = tz;
		vi.useFakeTimers();
		vi.setSystemTime(at(2026, 11, 8, 8, 0));
		const groups = groupConversations([
			chat("week-start", at(2026, 11, 1, 0, 0)),
			chat("before-week", at(2026, 10, 31, 23, 59)),
			chat("month-start", at(2026, 10, 8, 0, 0)),
			chat("older", at(2026, 10, 7, 23, 59)),
		]);
		expect(ids(groups.week)).toEqual(["week-start"]);
		expect(ids(groups.month)).toEqual(["before-week", "month-start"]);
		expect(ids(groups.older)).toEqual(["older"]);
	});

	it("files by lastActivityAt, not updatedAt, and falls back to updatedAt without it", () => {
		process.env.TZ = tz;
		vi.useFakeTimers();
		vi.setSystemTime(at(2026, 11, 8, 8, 0));
		const touched = at(2026, 11, 8, 6, 0);
		const groups = groupConversations([
			chat("housekept", at(2026, 10, 20), touched),
			{ id: "legacy", updatedAt: touched },
		]);
		expect(ids(groups.today)).toEqual(["legacy"]);
		expect(ids(groups.month)).toEqual(["housekept"]);
	});
});
