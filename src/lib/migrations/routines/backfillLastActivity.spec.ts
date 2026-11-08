import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { backfillLastActivity } from "./backfillLastActivity";

const sessionId = `backfill-${new ObjectId()}`;

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.conversations.deleteMany({ sessionId });
});

const d = (iso: string) => new Date(iso);

async function chat(over: Record<string, unknown>) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		sessionId,
		title: "t",
		model: "m",
		rootMessageId: "s",
		messages: [],
		createdAt: d("2026-01-01T00:00:00Z"),
		updatedAt: d("2026-03-01T00:00:00Z"),
		...over,
	} as never);
	return _id;
}
const read = async (id: ObjectId) =>
	(await collections.conversations.findOne({ _id: id }))?.lastActivityAt;

describe("backfilling lastActivityAt", () => {
	it("uses the newest message, else updatedAt, else createdAt", async () => {
		const m = (at: string) => ({ id: at, from: "user", content: "x", createdAt: d(at) });
		const withMessages = await chat({
			messages: [m("2026-02-01T00:00:00Z"), m("2026-02-05T00:00:00Z"), m("2026-02-03T00:00:00Z")],
		});
		const noMessages = await chat({});
		const noUpdated = await chat({ updatedAt: undefined });

		await backfillLastActivity(collections);

		expect((await read(withMessages))?.toISOString()).toBe("2026-02-05T00:00:00.000Z");
		expect((await read(noMessages))?.toISOString()).toBe("2026-03-01T00:00:00.000Z");
		expect((await read(noUpdated))?.toISOString()).toBe("2026-01-01T00:00:00.000Z");
	});

	it("is idempotent and leaves an existing value alone", async () => {
		const had = await chat({ lastActivityAt: d("2026-04-04T00:00:00Z") });
		const missing = await chat({});

		expect(await backfillLastActivity(collections)).toBeGreaterThanOrEqual(1);
		const first = await read(missing);
		expect(await backfillLastActivity(collections)).toBe(0);

		expect(await read(missing)).toEqual(first);
		expect((await read(had))?.toISOString()).toBe("2026-04-04T00:00:00.000Z");
	});

	it("works through more than one batch", async () => {
		const ids = await Promise.all(Array.from({ length: 1100 }, () => chat({})));
		await backfillLastActivity(collections);
		const filled = await collections.conversations.countDocuments({
			_id: { $in: ids },
			lastActivityAt: { $exists: true },
		});
		expect(filled).toBe(1100);
	});
});
