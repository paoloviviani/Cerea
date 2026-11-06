import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { LEGACY_SIGN_IN_AGAIN } from "$lib/server/schedules/grants";
import { reenableGrantExpiredSchedules } from "./reenableGrantExpiredSchedules";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.schedules.deleteMany({});
});

async function row(over: Record<string, unknown>) {
	const _id = new ObjectId();
	await collections.schedules.insertOne({
		_id,
		userId: new ObjectId(),
		kind: "chat",
		name: "s",
		target: {},
		prompt: "p",
		recurrence: { type: "daily", at: "09:00" },
		timezone: "UTC",
		anchorAt: new Date("2026-01-01T00:00:00Z"),
		enabled: false,
		nextRunAt: null,
		consecutiveFailures: 3,
		firedCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as never);
	return _id;
}

describe("re-enabling schedules switched off for an expired grant", () => {
	it("re-enables only the ones carrying the old sentence, with a fresh next run", async () => {
		const legacy = await row({ disabledReason: LEGACY_SIGN_IN_AGAIN });
		const stopped = await row({ disabledReason: "You stopped background access." });
		const agent = await row({ kind: "agent", disabledReason: LEGACY_SIGN_IN_AGAIN });

		expect(await reenableGrantExpiredSchedules(collections)).toBe(1);

		const fixed = await collections.schedules.findOne({ _id: legacy });
		expect(fixed?.enabled).toBe(true);
		expect(fixed?.disabledReason).toBeUndefined();
		expect(fixed?.consecutiveFailures).toBe(0);
		expect(fixed?.nextRunAt?.getTime()).toBeGreaterThan(Date.now());
		expect((await collections.schedules.findOne({ _id: stopped }))?.enabled).toBe(false);
		expect((await collections.schedules.findOne({ _id: agent }))?.enabled).toBe(false);
	});
});
