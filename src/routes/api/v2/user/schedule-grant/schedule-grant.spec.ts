import { beforeEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";

const flags = vi.hoisted(() => ({ gateway: true, revoked: [] as string[] }));
vi.mock("$lib/server/identity/gatewayLogin", async (original) => ({
	...(await original<typeof import("$lib/server/identity/gatewayLogin")>()),
	isGatewayPreset: () => flags.gateway,
}));
vi.mock("openid-client", async (original) => {
	const real = await original<typeof import("openid-client")>();
	class FakeClient {
		issuer = { metadata: { revocation_endpoint: "https://idp.invalid/revoke" } };
		async revoke(token: string) {
			flags.revoked.push(token);
		}
	}
	const issuer = { metadata: {}, Client: FakeClient };
	return { ...real, Issuer: Object.assign(function () {}, { discover: async () => issuer }) };
});

import { DELETE, GET } from "./+server";
import {
	hasGrant,
	saveGrant,
	scheduleGrantUsable,
	SIGN_IN_AGAIN,
} from "$lib/server/schedules/grants";

await ready;

let person: Awaited<ReturnType<typeof createTestUser>>;

async function call(handler: typeof GET, method = "GET") {
	const res = await testRequest(handler, {
		method,
		path: "/api/v2/user/schedule-grant",
		headers: { cookie: person.cookie },
	});
	return { status: res.status, data: superjson.parse<Record<string, unknown>>(await res.text()) };
}

async function chatSchedule(enabled = true) {
	await collections.schedules.insertOne({
		_id: new ObjectId(),
		userId: person.user._id,
		kind: "chat",
		name: "s",
		target: {},
		prompt: "p",
		recurrence: { type: "daily", at: "09:00" },
		timezone: "UTC",
		anchorAt: new Date(),
		enabled,
		nextRunAt: enabled ? new Date(Date.now() + 3600_000) : null,
		consecutiveFailures: 0,
		firedCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
}

beforeEach(async () => {
	await cleanupTestData();
	await collections.scheduleGrants.deleteMany({});
	await collections.schedules.deleteMany({});
	flags.gateway = true;
	flags.revoked = [];
	person = await createTestUser();
});

describe("background access for schedules", () => {
	it("says whether it is given and how many chat schedules depend on it", async () => {
		expect((await call(GET)).data).toMatchObject({
			required: true,
			granted: false,
			chatSchedules: 0,
		});
		await saveGrant(person.user._id, { refresh_token: "rt", access_token: "at" } as never);
		await chatSchedule();
		expect((await call(GET)).data).toMatchObject({ granted: true, active: true, chatSchedules: 1 });
	});

	it("is not required off a gateway", async () => {
		flags.gateway = false;
		expect((await call(GET)).data).toMatchObject({ required: false });
	});

	it("stopping keeps the grant (it keeps their sessions signed in), is not revoked at the IdP, and switches the chat schedules off with a reason", async () => {
		await saveGrant(person.user._id, { refresh_token: "rt", access_token: "at" } as never);
		await chatSchedule(true);
		await chatSchedule(false);

		const res = await call(DELETE, "DELETE");

		expect(res.data).toMatchObject({ revoked: true, disabled: 1 });
		expect(await hasGrant(person.user._id)).toBe(true);
		expect(await scheduleGrantUsable(person.user._id)).toBe(false);
		expect(flags.revoked).toEqual([]);
		const rows = await collections.schedules.find({ userId: person.user._id }).toArray();
		expect(rows.every((r) => !r.enabled)).toBe(true);
		expect(rows.some((r) => r.disabledReason?.includes("Background access was stopped"))).toBe(
			true
		);
		expect((await call(GET)).data).toMatchObject({ granted: true, active: false });
		expect(SIGN_IN_AGAIN).toContain("Sign in again");
	});

	it("needs a signed-in person", async () => {
		const res = await testRequest(GET, { method: "GET", path: "/api/v2/user/schedule-grant" });
		expect(res.status).toBeGreaterThanOrEqual(401);
	});
});
