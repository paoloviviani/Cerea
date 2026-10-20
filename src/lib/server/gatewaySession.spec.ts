import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { forgetGatewaySession, gatewaySessionCheck, settleGatewayFolds } from "./gatewaySession";

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
			// An older gateway answers with no `capabilities` key at all:
			// "absent", which reads as allowed (ADR 0096).
			capabilities: "absent",
		});
		await gatewaySessionCheck(sessionId, "tok", opts);
		expect(fetch.calls()).toBe(1);
		now += 61_000;
		await gatewaySessionCheck(sessionId, "tok", opts);
		expect(fetch.calls()).toBe(2);
		forgetGatewaySession(sessionId);
	});

	it("carries the gateway's capabilities answer in the cached outcome (ADR 0096)", async () => {
		const { sessionId, gatewayUserId } = await makeSession("gw-1c");
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, {
				id: gatewayUserId,
				is_admin: false,
				groups: [],
				capabilities: { code_agents: false, api_keys: true },
			}).impl,
		});
		expect(answer).toEqual({
			kind: "valid",
			isAdmin: false,
			groups: [],
			capabilities: { code_agents: false },
		});
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
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [], capabilities: "absent" });
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
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [], capabilities: "absent" });
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
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [], capabilities: "absent" });

		// The fold is launched in the background; wait for it to finish.
		await settleGatewayFolds();

		expect(await collections.users.findOne({ _id: strayId })).toBeNull();
		const movedConv = await collections.conversations.findOne({ _id: conv });
		expect(movedConv?.userId?.equals(userId)).toBe(true);
		const target = await collections.users.findOne({ _id: userId });
		expect(target?.lastMergeSyncAt?.toISOString()).toBe("2026-01-01T00:00:00.000Z");

		forgetGatewaySession(sessionId);
	});

	it("runs one fold at a time per user: a second check joins the one in flight", async () => {
		const { sessionId, gatewayUserId } = await makeSession("gw-5b");
		let identityFetches = 0;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const url = new URL(typeof input === "string" ? input : input.toString());
			const p = url.pathname.replace(/^.*\/v1/, "");
			if (p === "/me/identities") {
				identityFetches++;
				await gate;
				return new Response(
					JSON.stringify({ id: gatewayUserId, identities: [], merged_from: [] }),
					{ status: 200 }
				);
			}
			return new Response(
				JSON.stringify({
					id: gatewayUserId,
					is_admin: false,
					groups: [],
					merged_at: "2026-02-01T00:00:00Z",
				}),
				{ status: 200 }
			);
		}) as typeof fetch;

		await gatewaySessionCheck(sessionId, "tok", { ...base, fetchImpl });
		// Drop the cache so the second check really asks again, while the
		// first fold is parked on the gate and lastMergeSyncAt is still unset.
		forgetGatewaySession(sessionId);
		await gatewaySessionCheck(sessionId, "tok", { ...base, fetchImpl });
		release();
		await settleGatewayFolds();

		expect(identityFetches).toBe(1);
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

/**
 * The chat's half of the `/v1/me` contract (ADR 0096): how every shape the
 * gateway's answer can take is read. A mismatch here would make every person
 * look "absent = allowed" and quietly dissolve the per-person gate.
 *
 * The gateway's own half — that `GET /v1/me` carries `capabilities` with a
 * boolean `code_agents` for every credential, the chat's session access token
 * included — is answered by the gateway's `routers/identity.py`
 * (`CallerIdentity`, built unconditionally for access tokens and keys alike)
 * and its tests (`apps/gateway/tests/test_identity_policy.py`). These specs
 * pin the reading: a body without the key is an older gateway (`"absent"`),
 * a body with the key must say `true` to be allowed, and silence inside a
 * present key is a denial, never the allowance.
 */
describe("reading /v1/me's capabilities (the chat's half of the contract)", () => {
	beforeAll(async () => {
		await ready;
	});

	it.each([
		["grants the flag", { code_agents: true }, { code_agents: true }],
		["declines it", { code_agents: false }, { code_agents: false }],
		["speaks capabilities but grants nothing", {}, { code_agents: false }],
		["names only another capability", { api_keys: true }, { code_agents: false }],
		["sends an explicit null", null, { code_agents: false }],
	])("a body whose capabilities %s is read exactly", async (_name, capabilities, expected) => {
		const { sessionId, gatewayUserId } = await makeSession("cap");
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, {
				id: gatewayUserId,
				is_admin: false,
				groups: [],
				capabilities,
			}).impl,
		});
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [], capabilities: expected });
		forgetGatewaySession(sessionId);
	});

	it("a body with no capabilities key at all is the older-gateway shape: absent", async () => {
		const { sessionId, gatewayUserId } = await makeSession("cap-old");
		const answer = await gatewaySessionCheck(sessionId, "tok", {
			...base,
			fetchImpl: fakeFetch(200, {
				id: gatewayUserId,
				is_admin: false,
				groups: [],
			}).impl,
		});
		expect(answer).toEqual({ kind: "valid", isAdmin: false, groups: [], capabilities: "absent" });
		forgetGatewaySession(sessionId);
	});
});
