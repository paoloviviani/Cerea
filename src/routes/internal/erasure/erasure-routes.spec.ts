/**
 * The two `/internal/erasure*` routes end to end through the real `handle`
 * hook (ADR 0093 §9.3) — this is what actually proves the routes are
 * reachable with no session at all (the point of `INTERNAL_SERVICE_ROUTES`
 * in `handle.ts`). `assertInternalRequest` itself (the token check, the
 * proxy-header refusal) is `internalAuth.spec.ts`'s job in isolation; it's
 * mocked here to a single toggle so this file only has to prove the route
 * calls it and correctly turns a refusal into a 401 — `config` is a
 * process-wide snapshot no spec can flip per-test (the same reasoning
 * `updateUser.gateway.spec.ts` gives), and this route goes through the real
 * `handle` hook, which reads far more of it than just the erasure token.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { error } from "@sveltejs/kit";

import { collections, ready } from "$lib/server/database";
import { testRequest } from "$lib/server/__tests__/testRequest";

let refuse = false;
vi.mock("$lib/server/internalAuth", () => ({
	assertInternalRequest: () => {
		if (refuse) error(401, "refused");
	},
}));

const { POST: previewPOST } = await import("./preview/+server");
const { POST: erasePOST } = await import("./+server");

const HEADERS = { "content-type": "application/json" };

let insertedUserIds: ObjectId[] = [];
let insertedErasureIds: string[] = [];

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	refuse = false;
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	await collections.erasures.deleteMany({ _id: { $in: insertedErasureIds } });
	insertedUserIds = [];
	insertedErasureIds = [];
});

describe("POST /internal/erasure/preview", () => {
	it("answers with no session at all, once past assertInternalRequest", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		const res = await testRequest(previewPOST, {
			path: "/internal/erasure/preview",
			method: "POST",
			routeId: "/internal/erasure/preview",
			headers: HEADERS,
			body: JSON.stringify({ gateway_user_id: gatewayUserId, identities: [] }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.counts).toBeTypeOf("object");
		expect(body.unattributed_legacy_shares).toBeTypeOf("number");
		expect(body.shared).toEqual([]);
	});

	it("turns assertInternalRequest's refusal into a 401", async () => {
		refuse = true;
		const res = await testRequest(previewPOST, {
			path: "/internal/erasure/preview",
			method: "POST",
			routeId: "/internal/erasure/preview",
			headers: HEADERS,
			body: JSON.stringify({ gateway_user_id: "gw-x", identities: [] }),
		});
		expect(res.status).toBe(401);
	});

	it("answers 400 for a body missing gateway_user_id", async () => {
		const res = await testRequest(previewPOST, {
			path: "/internal/erasure/preview",
			method: "POST",
			routeId: "/internal/erasure/preview",
			headers: HEADERS,
			body: JSON.stringify({ identities: [] }),
		});
		expect(res.status).toBe(400);
	});
});

describe("POST /internal/erasure", () => {
	it("erases the named account and is idempotent on a repeat", async () => {
		const gatewayUserId = `gw-${new ObjectId()}`;
		const user = {
			_id: new ObjectId(),
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId,
		};
		await collections.users.insertOne(user as never);
		insertedUserIds.push(user._id);
		const erasureId = `erasure-${new ObjectId()}`;
		insertedErasureIds.push(erasureId);

		const first = await testRequest(erasePOST, {
			path: "/internal/erasure",
			method: "POST",
			routeId: "/internal/erasure",
			headers: HEADERS,
			body: JSON.stringify({
				erasure_id: erasureId,
				gateway_user_id: gatewayUserId,
				identities: [],
			}),
		});
		expect(first.status).toBe(200);
		const firstBody = await first.json();
		expect(firstBody.erasure_id).toBe(erasureId);
		expect(await collections.users.findOne({ _id: user._id })).toBeNull();

		const second = await testRequest(erasePOST, {
			path: "/internal/erasure",
			method: "POST",
			routeId: "/internal/erasure",
			headers: HEADERS,
			body: JSON.stringify({
				erasure_id: erasureId,
				gateway_user_id: gatewayUserId,
				identities: [],
			}),
		});
		expect(second.status).toBe(200);
		const secondBody = await second.json();
		expect(secondBody).toEqual(firstBody);
	});

	it("turns assertInternalRequest's refusal into a 401", async () => {
		refuse = true;
		const res = await testRequest(erasePOST, {
			path: "/internal/erasure",
			method: "POST",
			routeId: "/internal/erasure",
			headers: HEADERS,
			body: JSON.stringify({ erasure_id: "x", gateway_user_id: "gw-x", identities: [] }),
		});
		expect(res.status).toBe(401);
	});
});
