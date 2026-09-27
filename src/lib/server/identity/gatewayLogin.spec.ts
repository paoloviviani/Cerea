import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { mockGateway } from "./mockGateway";
import { foldPendingStrays, GatewayLoginError, resolveGatewayLogin } from "./gatewayLogin";

const BASE_URL = "http://gateway.invalid/v1";

// Every user this file inserts, so `afterEach` can remove it regardless of
// how the test ends — a merge or an adoption deletes some of these before
// the test is done, but `deleteMany` over ids that are already gone is a
// no-op, not an error.
let insertedUserIds: ObjectId[] = [];

async function insertUser(fields: Partial<import("$lib/types/User").User>) {
	const doc = {
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		name: "somebody",
		hfUserId: fields.hfUserId ?? new ObjectId().toString(),
		...fields,
	};
	await collections.users.insertOne(doc as never);
	insertedUserIds.push(doc._id);
	return doc;
}

describe("resolveGatewayLogin (ADR 0093 §4.3)", () => {
	beforeAll(async () => {
		await ready;
	});

	afterEach(async () => {
		await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
		insertedUserIds = [];
	});

	it("resolves to the existing target when gatewayUserId already matches", async () => {
		const gateway = mockGateway();
		const target = await insertUser({ gatewayUserId: "gw-1" });
		gateway.tokens.set("tok-1", { id: "gw-1", identities: [] });

		const resolved = await resolveGatewayLogin("tok-1", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});

		expect(resolved.user?._id.equals(target._id)).toBe(true);
		expect(resolved.pendingStrays).toHaveLength(0);
	});

	it("adopts the one stray that matches by (issuer, hfUserId), lazily backfilling gatewayUserId", async () => {
		const gateway = mockGateway();
		const stray = await insertUser({ issuer: "https://old.example.org", hfUserId: "old-sub" });
		gateway.tokens.set("tok-2", {
			id: "gw-2",
			identities: [{ issuer: "https://old.example.org", subject: "old-sub" }],
		});

		const resolved = await resolveGatewayLogin("tok-2", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});

		expect(resolved.user?._id.equals(stray._id)).toBe(true);
		const reloaded = await collections.users.findOne({ _id: stray._id });
		expect(reloaded?.gatewayUserId).toBe("gw-2");
	});

	it("merges every remaining stray into the target before returning it", async () => {
		const gateway = mockGateway();
		const target = await insertUser({ gatewayUserId: "gw-3" });
		const strayByMerge = await insertUser({ gatewayUserId: "gw-3-old" });
		const strayByIdentity = await insertUser({
			issuer: "https://old.example.org",
			hfUserId: "another-old-sub",
		});
		const conv1 = new ObjectId();
		const conv2 = new ObjectId();
		await collections.conversations.insertMany([
			{
				_id: conv1,
				userId: strayByMerge._id,
				title: "t",
				messages: [],
				model: "m",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				_id: conv2,
				userId: strayByIdentity._id,
				title: "t",
				messages: [],
				model: "m",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		] as never);
		gateway.tokens.set("tok-3", {
			id: "gw-3",
			identities: [{ issuer: "https://old.example.org", subject: "another-old-sub" }],
			mergedFrom: ["gw-3-old"],
		});

		const resolved = await resolveGatewayLogin("tok-3", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});

		expect(resolved.user?._id.equals(target._id)).toBe(true);
		expect(await collections.users.findOne({ _id: strayByMerge._id })).toBeNull();
		expect(await collections.users.findOne({ _id: strayByIdentity._id })).toBeNull();
		const movedConv1 = await collections.conversations.findOne({ _id: conv1 });
		const movedConv2 = await collections.conversations.findOne({ _id: conv2 });
		expect(movedConv1?.userId?.equals(target._id)).toBe(true);
		expect(movedConv2?.userId?.equals(target._id)).toBe(true);

		await collections.conversations.deleteMany({ _id: { $in: [conv1, conv2] } });
	});

	it("returns no user and no pending strays for a genuinely new gateway id", async () => {
		const gateway = mockGateway();
		gateway.tokens.set("tok-4", { id: "gw-4-new", identities: [] });

		const resolved = await resolveGatewayLogin("tok-4", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});

		expect(resolved.user).toBeNull();
		expect(resolved.gatewayUserId).toBe("gw-4-new");
		expect(resolved.pendingStrays).toHaveLength(0);
	});

	it("returns pending strays (not yet merged) when several match but there is no target to anchor on", async () => {
		const gateway = mockGateway();
		const strayA = await insertUser({ issuer: "https://a.example.org", hfUserId: "sub-a" });
		const strayB = await insertUser({ issuer: "https://b.example.org", hfUserId: "sub-b" });
		gateway.tokens.set("tok-5", {
			id: "gw-5-new",
			identities: [
				{ issuer: "https://a.example.org", subject: "sub-a" },
				{ issuer: "https://b.example.org", subject: "sub-b" },
			],
		});

		const resolved = await resolveGatewayLogin("tok-5", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});

		expect(resolved.user).toBeNull();
		expect(resolved.pendingStrays.map((id) => id.toString()).sort()).toEqual(
			[strayA._id.toString(), strayB._id.toString()].sort()
		);

		// And folding them in, once the caller has created the target row:
		const createdTarget = await insertUser({ gatewayUserId: "gw-5-new" });
		await foldPendingStrays(createdTarget._id, resolved.pendingStrays);
		expect(await collections.users.findOne({ _id: strayA._id })).toBeNull();
		expect(await collections.users.findOne({ _id: strayB._id })).toBeNull();
	});

	it("fails closed on a network error, without creating anything", async () => {
		const gateway = mockGateway();
		gateway.failure = "down";

		await expect(
			resolveGatewayLogin("tok-6", { baseUrl: BASE_URL, fetchImpl: gateway.fetch })
		).rejects.toMatchObject({
			status: 503,
			message: "The gateway is unavailable, try again in a minute.",
		});
	});

	it("fails closed on a 5xx, with the same generic message", async () => {
		const gateway = mockGateway();
		gateway.failure = 500;

		await expect(
			resolveGatewayLogin("tok-7", { baseUrl: BASE_URL, fetchImpl: gateway.fetch })
		).rejects.toThrow(GatewayLoginError);
	});

	it("surfaces the gateway's own message on a 401/403 refusal", async () => {
		const gateway = mockGateway();
		// No token registered: the mock answers 401 "Invalid API key provided."
		await expect(
			resolveGatewayLogin("unknown-token", { baseUrl: BASE_URL, fetchImpl: gateway.fetch })
		).rejects.toMatchObject({ status: 401, message: "Invalid API key provided." });
	});

	it("refuses without ever calling the gateway when there is no access token", async () => {
		const gateway = mockGateway();
		await expect(
			resolveGatewayLogin(undefined, { baseUrl: BASE_URL, fetchImpl: gateway.fetch })
		).rejects.toBeInstanceOf(GatewayLoginError);
		expect(gateway.calls).toHaveLength(0);
	});
});
