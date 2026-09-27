/**
 * Pins the fix found while wiring §4.4 (`gatewaySession.ts`'s commit): on a
 * gateway preset, `event.locals.isAdmin` must reflect the gateway's own
 * `is_admin` answer (via `authenticateRequest`'s `auth.isAdmin`), not
 * `event.locals.user?.isAdmin` — which `updateUser.ts`'s login callback never
 * sets on a gateway preset (the gateway decides), so that read was always
 * `false` regardless of what the gateway actually said.
 *
 * `gatewaySessionCheck` is mocked wholesale rather than driven through a real
 * `/v1/me` call: config (and so `OPENAI_BASE_URL`/`USE_USER_TOKEN`) is a
 * process-wide snapshot no spec can flip per test, the same reasoning
 * `updateUser.gateway.spec.ts` gives — this file is about `handle.ts`'s own
 * wiring of the answer, not about `gatewaySessionCheck` itself (covered in
 * its own spec).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

import { collections, ready } from "$lib/server/database";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { sha256 } from "$lib/utils/sha256";

let gatewayOutcome: { kind: string; isAdmin?: boolean; groups?: string[] } | null = null;

vi.mock("$lib/server/gatewaySession", () => ({
	gatewaySessionCheck: async () => gatewayOutcome,
	forgetGatewaySession: () => {},
}));

const { GET: featureFlagsGET } = await import("../../../routes/api/v2/feature-flags/+server");

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

let insertedUserIds: ObjectId[] = [];
let insertedSessionIds: string[] = [];

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	gatewayOutcome = null;
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	await collections.sessions.deleteMany({ sessionId: { $in: insertedSessionIds } });
	insertedUserIds = [];
	insertedSessionIds = [];
});

/** A real, cookie-addressable session — `authenticateRequest` only calls
 * `gatewaySessionCheck` at all once `findUser` has resolved a real user and
 * an oauth token from a real session row, so `locals` overrides (which
 * `misc.spec.ts`'s own tests use) don't exercise this path — they apply
 * only after `handle` has already finished authenticating. */
async function signedInCookie(): Promise<string> {
	const user = await collections.users.insertOne({
		_id: new ObjectId(),
		createdAt: new Date(),
		updatedAt: new Date(),
		name: "n",
		hfUserId: new ObjectId().toString(),
		gatewayUserId: `gw-${new ObjectId()}`,
	} as never);
	insertedUserIds.push(user.insertedId);

	const secretSessionId = crypto.randomUUID();
	const sessionId = await sha256(secretSessionId);
	await collections.sessions.insertOne({
		_id: new ObjectId(),
		sessionId,
		userId: user.insertedId,
		createdAt: new Date(),
		updatedAt: new Date(),
		expiresAt: new Date(Date.now() + 1000 * 60 * 60),
		oauth: {
			token: { value: "test-access-token", expiresAt: new Date(Date.now() + 1000 * 60 * 60) },
		},
	} as never);
	insertedSessionIds.push(sessionId);

	return `hf-chat=${secretSessionId}`;
}

describe("handle.ts: locals.isAdmin follows the gateway's answer", () => {
	it("is true when the gateway says is_admin: true", async () => {
		const cookie = await signedInCookie();
		gatewayOutcome = { kind: "valid", isAdmin: true, groups: [] };

		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			headers: { cookie },
		});
		const data = await parseResponse<{ isAdmin: boolean }>(res);
		expect(data.isAdmin).toBe(true);
	});

	it("is false when the gateway says is_admin: false", async () => {
		const cookie = await signedInCookie();
		gatewayOutcome = { kind: "valid", isAdmin: false, groups: [] };

		const res = await testRequest(featureFlagsGET, {
			path: "/api/v2/feature-flags",
			headers: { cookie },
		});
		const data = await parseResponse<{ isAdmin: boolean }>(res);
		expect(data.isAdmin).toBe(false);
	});
});
