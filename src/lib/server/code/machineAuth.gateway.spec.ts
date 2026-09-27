/**
 * `resolveMachineUser`'s gateway-preset branch (ADR 0093 §4.7), isolated
 * from real config the same way `updateUser.gateway.spec.ts` is:
 * `isGatewayPreset` is mocked wholesale (config is a process-wide snapshot
 * no spec can flip per-test), while the gateway call itself goes through
 * `mockGateway()` via the `options` parameter — no module mock needed for
 * that part.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { mockGateway } from "$lib/server/identity/mockGateway";

vi.mock("$lib/server/identity/gatewayLogin", async () => {
	const actual = await vi.importActual<typeof import("$lib/server/identity/gatewayLogin")>(
		"$lib/server/identity/gatewayLogin"
	);
	return { ...actual, isGatewayPreset: () => true };
});

const { resolveMachineUser, resetMachineUserCacheForTests } = await import("./machineAuth");

const BASE_URL = "http://gateway.invalid/v1";
let insertedUserIds: ObjectId[] = [];

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	resetMachineUserCacheForTests();
	await collections.users.deleteMany({ _id: { $in: insertedUserIds } });
	insertedUserIds = [];
});

describe("resolveMachineUser on a gateway preset", () => {
	it("resolves the user by gatewayUserId from GET /v1/me", async () => {
		const gateway = mockGateway();
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: "gw-machine-1",
		} as never);
		insertedUserIds.push(userId);
		gateway.tokens.set("tok-1", { id: "gw-machine-1", identities: [] });

		const resolution = await resolveMachineUser("sub-1", 123, "tok-1", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(resolution.ok).toBe(true);
		if (resolution.ok) expect(resolution.user._id.equals(userId)).toBe(true);
	});

	it("refuses with 403 when the gateway id matches no chat user", async () => {
		const gateway = mockGateway();
		gateway.tokens.set("tok-2", { id: "gw-nobody", identities: [] });

		const resolution = await resolveMachineUser("sub-2", 123, "tok-2", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(resolution).toMatchObject({ ok: false, status: 403, refused: true });
	});

	it("refuses with 401 (refused: true) when the gateway rejects the token", async () => {
		const gateway = mockGateway();
		const resolution = await resolveMachineUser("sub-3", 123, "unknown-token", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(resolution).toMatchObject({ ok: false, status: 401, refused: true });
	});

	it("falls back to the last cached answer on a network error, marked refused: false", async () => {
		const gateway = mockGateway();
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: "gw-machine-4",
		} as never);
		insertedUserIds.push(userId);
		gateway.tokens.set("tok-4", { id: "gw-machine-4", identities: [] });

		const first = await resolveMachineUser("sub-4", 999, "tok-4", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(first.ok).toBe(true);

		gateway.failure = "down";
		// Same (sub, exp): the 60s cache still holds the good answer, so a
		// network error never even reaches the "no cache" branch here — this
		// asserts the cache-hit path specifically.
		const second = await resolveMachineUser("sub-4", 999, "tok-4", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(second).toEqual(first);
	});

	it("refuses (refused: false) on a network error with nothing cached", async () => {
		const gateway = mockGateway();
		gateway.failure = "down";
		const resolution = await resolveMachineUser("sub-5", 123, "tok-5", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(resolution).toMatchObject({ ok: false, status: 401, refused: false });
	});

	it("fails open for up to 5 minutes since the last good answer for that sub, across a token renewal", async () => {
		const gateway = mockGateway();
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: "gw-machine-7",
		} as never);
		insertedUserIds.push(userId);
		gateway.tokens.set("tok-7a", { id: "gw-machine-7", identities: [] });

		let now = 1_000_000;
		const good = await resolveMachineUser("sub-7", 100, "tok-7a", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(good.ok).toBe(true);

		// A token renewal: a new exp, so the plain (sub, exp) cache can't be
		// what's serving this — only the per-sub last-good-answer can.
		gateway.failure = "down";
		now += 4 * 60_000;
		const stillOpen = await resolveMachineUser("sub-7", 200, "tok-7b", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(stillOpen).toEqual(good);
	});

	it("refuses (refused: false), not fails open, once the 5-minute bound has passed", async () => {
		const gateway = mockGateway();
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: "gw-machine-8",
		} as never);
		insertedUserIds.push(userId);
		gateway.tokens.set("tok-8", { id: "gw-machine-8", identities: [] });

		let now = 2_000_000;
		const good = await resolveMachineUser("sub-8", 100, "tok-8", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(good.ok).toBe(true);

		gateway.failure = "down";
		now += 5 * 60_000 + 1;
		const pastGrace = await resolveMachineUser("sub-8", 200, "tok-8", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(pastGrace).toMatchObject({ ok: false, refused: false });
	});

	it("a real refusal clears the grace: no stale good answer survives it", async () => {
		const gateway = mockGateway();
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: "gw-machine-9",
		} as never);
		insertedUserIds.push(userId);
		gateway.tokens.set("tok-9", { id: "gw-machine-9", identities: [] });

		let now = 3_000_000;
		const good = await resolveMachineUser("sub-9", 100, "tok-9", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(good.ok).toBe(true);

		// The account is disabled: a real 401, well within what would
		// otherwise be the grace window.
		now += 60_000;
		gateway.tokens.delete("tok-9");
		const refused = await resolveMachineUser("sub-9", 200, "tok-9", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(refused).toMatchObject({ ok: false, refused: true });

		// Immediately after, unreachable: must not fall back to the good
		// answer from before the refusal.
		gateway.failure = "down";
		now += 1000;
		const afterRefusal = await resolveMachineUser("sub-9", 300, "tok-9", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
			now: () => now,
		});
		expect(afterRefusal).toMatchObject({ ok: false, refused: false });
	});

	it("carries sessions_valid_after through on a valid answer", async () => {
		const gateway = mockGateway();
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "n",
			hfUserId: new ObjectId().toString(),
			gatewayUserId: "gw-machine-6",
		} as never);
		insertedUserIds.push(userId);
		gateway.tokens.set("tok-6", {
			id: "gw-machine-6",
			identities: [],
			sessionsValidAfter: "2026-01-01T00:00:00Z",
		});

		const resolution = await resolveMachineUser("sub-6", 123, "tok-6", {
			baseUrl: BASE_URL,
			fetchImpl: gateway.fetch,
		});
		expect(resolution).toMatchObject({ ok: true, sessionsValidAfter: "2026-01-01T00:00:00Z" });
	});
});
