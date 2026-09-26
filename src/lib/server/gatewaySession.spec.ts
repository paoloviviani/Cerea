import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { forgetGatewaySession, gatewaySessionCheck } from "./gatewaySession";

function fakeFetch(status: number, body: unknown = {}) {
	let calls = 0;
	const impl = (async () => {
		calls++;
		return new Response(JSON.stringify(body), { status });
	}) as typeof fetch;
	return { impl, calls: () => calls };
}

const base = { baseUrl: "http://gateway:8000/v1", userToken: true };

// Every gatewayUserId this file mints is namespaced under one run id, so a
// rerun against the same persistent test-mongo container never collides
// with a leftover row on the unique partial gatewayUserId index.
const RUN = new ObjectId().toString();
let insertedUserIds: ObjectId[] = [];
let insertedConversationIds: ObjectId[] = [];

afterEach(async () => {
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	await collections.conversations.deleteMany({ _id: { $in: insertedConversationIds } });
	insertedUserIds = [];
	insertedConversationIds = [];
});

async function makeSession(gatewayUserIdSuffix: string, createdAt = new Date()) {
	const gatewayUserId = `${RUN}-${gatewayUserIdSuffix}`;
	const userId = new ObjectId();
	await collections.users.insertOne({
		_id: userId,
		createdAt: new Date(),
		updatedAt: new Date(),
		name: "n",
		hfUserId: new ObjectId().toString(),
		gatewayUserId,
	} as never);
	insertedUserIds.push(userId);
	const sessionId = `s-${new ObjectId().toString()}`;
	await collections.sessions.insertOne({
		_id: new ObjectId(),
		sessionId,
		userId,
		createdAt,
		updatedAt: new Date(),
		expiresAt: new Date(Date.now() + 1000 * 60 * 60),
	} as never);
	return { sessionId, userId, gatewayUserId };
}

describe("gatewaySessionCheck (ADR 0093 §4.4)", () => {
	beforeAll(async () => {
		await ready;
	});

	it("reads admin and groups from /v1/me and caches them for a minute", async () => {
		const { sessionId, gatewayUserId } = await makeSession("gw-1");
		const fetch = fakeFetch(200, { id: gatewayUserId, is_admin: true, groups: ["ops"] });
		let now = 1_000_000;
		const opts = { ...base, fetchImpl: fetch.impl, now: () => now };
		expect(await gatewaySessionCheck(sessionId, "tok", opts)).toEqual({
			kind: "valid",
			isAdmin: true,
			groups: ["ops"],
		});
		await gatewaySessionCheck(sessionId, "tok", opts);
		expect(fetch.calls()).toBe(1);
		now += 61_000;
		await gatewaySessionCheck(sessionId, "tok", opts);
		expect(fetch.calls()).toBe(2);
		forgetGatewaySession(sessionId);
	});

	it("ends the session on a 401", async () => {
		const { sessionId } = await makeSession("gw-2");
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(401).impl,
		});
		expect(answer).toEqual({ kind: "ended" });
		forgetGatewaySession(sessionId);
	});

	it("ends the session when the gateway's id no longer matches (merged elsewhere)", async () => {
		const { sessionId } = await makeSession("gw-old");
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, { id: `${RUN}-gw-new`, is_admin: false, groups: [] }).impl,
		});
		expect(answer).toEqual({ kind: "ended" });
		forgetGatewaySession(sessionId);
	});

	it("does not end the session over an id mismatch when the user has no gatewayUserId yet", async () => {
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
		} as never);
		insertedUserIds.push(userId);
		const sessionId = `s-${new ObjectId().toString()}`;
		await collections.sessions.insertOne({
			_id: new ObjectId(),
			sessionId,
			userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			expiresAt: new Date(Date.now() + 1000 * 60 * 60),
		} as never);

		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, { id: `${RUN}-gw-anything`, is_admin: false, groups: [] }).impl,
		});
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [] });
		forgetGatewaySession(sessionId);
	});

	it("ends the session when sessions_valid_after postdates its own createdAt", async () => {
		const { sessionId, gatewayUserId } = await makeSession(
			"gw-3",
			new Date("2020-01-01T00:00:00Z")
		);
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, {
				id: gatewayUserId,
				is_admin: false,
				groups: [],
				sessions_valid_after: "2021-01-01T00:00:00Z",
			}).impl,
		});
		expect(answer).toEqual({ kind: "ended" });
		forgetGatewaySession(sessionId);
	});

	it("stays valid when sessions_valid_after predates the session", async () => {
		const { sessionId, gatewayUserId } = await makeSession(
			"gw-4",
			new Date("2022-01-01T00:00:00Z")
		);
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, {
				id: gatewayUserId,
				is_admin: false,
				groups: [],
				sessions_valid_after: "2021-01-01T00:00:00Z",
			}).impl,
		});
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [] });
		forgetGatewaySession(sessionId);
	});

	it("folds a merged identity in the background and stamps lastMergeSyncAt", async () => {
		const { sessionId, userId, gatewayUserId } = await makeSession("gw-5");
		const strayGatewayUserId = `${RUN}-gw-5-old`;
		const strayId = new ObjectId();
		await collections.users.insertOne({
			_id: strayId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "stray",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: strayGatewayUserId,
		} as never);
		insertedUserIds.push(strayId);
		const conv = new ObjectId();
		await collections.conversations.insertOne({
			_id: conv,
			userId: strayId,
			title: "t",
			messages: [],
			model: "m",
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		insertedConversationIds.push(conv);

		const path = new Map<string, unknown>();
		path.set("/me", {
			id: gatewayUserId,
			is_admin: false,
			groups: [],
			merged_at: "2026-01-01T00:00:00Z",
		});
		path.set("/me/identities", {
			id: gatewayUserId,
			identities: [],
			merged_from: [strayGatewayUserId],
		});
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === "string" ? input : input.toString());
			const p = url.pathname.replace(/^.*\/v1/, "");
			return new Response(JSON.stringify(path.get(p) ?? {}), { status: 200 });
		}) as typeof fetch;

		const answer = await gatewaySessionCheck(sessionId, "tok", { ...base, fetchImpl });
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [] });

		// The fold is launched in the background; give it a turn to run.
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(await collections.users.findOne({ _id: strayId })).toBeNull();
		const movedConv = await collections.conversations.findOne({ _id: conv });
		expect(movedConv?.userId?.equals(userId)).toBe(true);
		const target = await collections.users.findOne({ _id: userId });
		expect(target?.lastMergeSyncAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

		forgetGatewaySession(sessionId);
	});

	it("fails open when the gateway is unreachable, within the five-minute grace", async () => {
		const { sessionId, gatewayUserId } = await makeSession("gw-6");
		let now = 2_000_000;
		const broken = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		// A first good answer establishes `lastGoodAnswerAt`.
		await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, { id: gatewayUserId, is_admin: false, groups: [] }).impl,
			now: () => now,
		});
		now += 61_000; // past the 60s cache TTL, still well within 5 minutes
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: broken,
			now: () => now,
		});
		expect(answer).toEqual({ kind: "open" });
		forgetGatewaySession(sessionId);
	});

	it("answers unavailable once unreachable for more than five minutes straight", async () => {
		const { sessionId, gatewayUserId } = await makeSession("gw-7");
		let now = 3_000_000;
		const broken = (async () => {
			throw new Error("ECONNREFUSED");
		}) as typeof fetch;
		await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, { id: gatewayUserId, is_admin: false, groups: [] }).impl,
			now: () => now,
		});
		now += 5 * 60_000 + 61_000; // past both the cache TTL and the 5-minute grace
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: broken,
			now: () => now,
		});
		expect(answer).toEqual({ kind: "unavailable" });
		forgetGatewaySession(sessionId);
	});

	it("asks nobody without a gateway, a user token or a token", async () => {
		const fetch = fakeFetch(200);
		expect(
			await gatewaySessionCheck("s-any", "tok", {
				baseUrl: "",
				userToken: true,
				fetchImpl: fetch.impl,
			})
		).toBeNull();
		expect(
			await gatewaySessionCheck("s-any", "tok", {
				...base,
				userToken: false,
				fetchImpl: fetch.impl,
			})
		).toBeNull();
		expect(await gatewaySessionCheck("s-any", "", { ...base, fetchImpl: fetch.impl })).toBeNull();
		expect(fetch.calls()).toBe(0);
	});
});
