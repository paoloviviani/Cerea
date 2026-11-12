import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { backfillScheduleCounts } from "./backfillScheduleCounts";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.schedules.deleteMany({});
	await collections.scheduleCounts.deleteMany({});
});

async function rows(userId: ObjectId, n: number) {
	await collections.schedules.insertMany(
		Array.from({ length: n }, () => ({ _id: new ObjectId(), userId }) as never)
	);
}

describe("backfilling the schedule counts", () => {
	it("sets each count to the rows the user has, fixes wrong ones and drops orphans", async () => {
		const a = new ObjectId();
		const b = new ObjectId();
		const orphan = new ObjectId();
		await rows(a, 3);
		await rows(b, 1);
		await collections.scheduleCounts.insertMany([
			{ _id: b, count: 9 },
			{ _id: orphan, count: 2 },
		]);
		expect(await backfillScheduleCounts(collections)).toBe(2);
		expect((await collections.scheduleCounts.findOne({ _id: a }))?.count).toBe(3);
		expect((await collections.scheduleCounts.findOne({ _id: b }))?.count).toBe(1);
		expect(await collections.scheduleCounts.findOne({ _id: orphan })).toBeNull();
		// A re-run changes nothing.
		expect(await backfillScheduleCounts(collections)).toBe(2);
		expect(await collections.scheduleCounts.countDocuments({})).toBe(2);
	});
});
