import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import {
	ANON_ROWS_PER_IP_PER_HOUR,
	ANON_SETTINGS_MAX_ROWS,
	_resetAnonymousSettingsState,
	guardAnonymousSettingsRow,
	touchAnonymousSettings,
} from "./anonymousSettings";
import { POST as subscribeModel } from "../../routes/api/v2/models/[namespace]/[model]/subscribe/+server";

beforeAll(async () => {
	await ready;
});
beforeEach(async () => {
	await cleanupTestData();
	await collections.settings.deleteMany({});
	_resetAnonymousSettingsState();
});

const anon = (id: string) => ({ sessionId: id }) as App.Locals;
const status = (p: Promise<unknown>) =>
	p.then(
		() => 200,
		(e: { status?: number }) => e.status
	);

describe("guardAnonymousSettingsRow", () => {
	it("limits new anonymous rows per address per hour, then lets another address in", async () => {
		for (let i = 0; i < ANON_ROWS_PER_IP_PER_HOUR; i++) {
			const id = `s${i}`;
			expect(await status(guardAnonymousSettingsRow(anon(id), "1.1.1.1"))).toBe(200);
			await collections.settings.insertOne({
				sessionId: id,
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
		}
		expect(await status(guardAnonymousSettingsRow(anon("new"), "1.1.1.1"))).toBe(429);
		expect(await status(guardAnonymousSettingsRow(anon("new"), "2.2.2.2"))).toBe(200);
		// an existing row is never refused
		expect(await status(guardAnonymousSettingsRow(anon("s0"), "1.1.1.1"))).toBe(200);
		// an hour later the address is clear
		expect(
			await status(guardAnonymousSettingsRow(anon("later"), "1.1.1.1", Date.now() + 3_700_000))
		).toBe(200);
	});

	it("enforces the global cap", async () => {
		await collections.settings.insertMany(
			Array.from({ length: ANON_SETTINGS_MAX_ROWS }, (_, i) => ({
				sessionId: `b${i}`,
				createdAt: new Date(),
				updatedAt: new Date(),
			})) as never
		);
		expect(await status(guardAnonymousSettingsRow(anon("x"), "3.3.3.3"))).toBe(429);
	}, 60000);

	it("the model-subscribe routes go through it (no cap bypass)", async () => {
		await collections.settings.insertMany(
			Array.from({ length: ANON_SETTINGS_MAX_ROWS }, (_, i) => ({
				sessionId: `b${i}`,
				createdAt: new Date(),
				updatedAt: new Date(),
			})) as never
		);
		const res = await status(
			Promise.resolve(
				subscribeModel({
					params: { namespace: "ns", model: "m" },
					locals: anon("fresh"),
					getClientAddress: () => "4.4.4.4",
				} as never)
			)
		);
		expect(res).toBe(429);
		expect(await collections.settings.countDocuments({ sessionId: "fresh" })).toBe(0);
	}, 60000);
});

describe("touchAnonymousSettings keeps a returning visitor's row", () => {
	it("refreshes an old row once a day and leaves a recent one", async () => {
		const old = new Date(Date.now() - 6 * 86_400_000);
		await collections.settings.insertOne({
			sessionId: "me",
			createdAt: old,
			updatedAt: old,
		} as never);
		await touchAnonymousSettings("me");
		const row = await collections.settings.findOne({ sessionId: "me" });
		expect(Date.now() - (row?.updatedAt.getTime() ?? 0)).toBeLessThan(60_000);
		// throttled: a second call within the day does nothing
		await collections.settings.updateOne({ sessionId: "me" }, { $set: { updatedAt: old } });
		await touchAnonymousSettings("me");
		expect((await collections.settings.findOne({ sessionId: "me" }))?.updatedAt.getTime()).toBe(
			old.getTime()
		);
	});
});
