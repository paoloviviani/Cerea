/**
 * `updateUser.ts`'s gateway-preset wiring (ADR 0093 §4.2-4.3), isolated from
 * real config: `isGatewayPreset`/`resolveGatewayLogin`/`foldPendingStrays`
 * are mocked wholesale, since `config` is a process-wide snapshot no spec
 * can flip per-test (see `vitest-setup-server.ts`'s note on
 * `CODE_MACHINE_ISSUER`). `resolveGatewayLogin` itself is exercised for
 * real, against `mockGateway()`, in `gatewayLogin.spec.ts`; this file is
 * only about whether `updateUser.ts` wires the three calls correctly.
 */
import { afterEach, assert, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import type { Cookies } from "@sveltejs/kit";
import type { TokenSet } from "openid-client";

import { collections, ready } from "$lib/server/database";
import { GatewayLoginError } from "$lib/server/identity/gatewayLogin";

const resolveGatewayLogin = vi.fn();
const foldPendingStrays = vi.fn();
const isGatewayPreset = vi.fn(() => true);

vi.mock("$lib/server/identity/gatewayLogin", async () => {
	const actual = await vi.importActual<typeof import("$lib/server/identity/gatewayLogin")>(
		"$lib/server/identity/gatewayLogin"
	);
	return {
		...actual,
		isGatewayPreset: () => isGatewayPreset(),
		resolveGatewayLogin: (...args: unknown[]) => resolveGatewayLogin(...args),
		foldPendingStrays: (...args: unknown[]) => foldPendingStrays(...args),
	};
});

const { updateUser } = await import("./updateUser");

const userData = {
	preferred_username: "gw-username",
	name: "Gateway Person",
	sub: "gw-sub",
	email: "gw-person@example.org",
};
Object.freeze(userData);

const token = {
	access_token: "gw-access-token",
	expires_at: Math.floor(Date.now() / 1000) + 3600,
	expires_in: 3600,
} as TokenSet;

// @ts-expect-error SvelteKit cookies dumb mock
const cookiesMock: Cookies = { set: vi.fn() };

beforeAll(async () => {
	await ready;
});

afterEach(() => {
	vi.clearAllMocks();
});

describe("updateUser on a gateway preset", () => {
	it("stamps gatewayUserId on a brand-new account and folds the pending strays", async () => {
		const gatewayUserId = `gw-${new ObjectId().toString()}`;
		const strayId = new ObjectId();
		resolveGatewayLogin.mockResolvedValueOnce({
			user: null,
			gatewayUserId,
			pendingStrays: [strayId],
		});

		const locals = { sessionId: new ObjectId().toString() } as unknown as App.Locals;
		await updateUser({ userData, token, locals, cookies: cookiesMock });

		const created = await collections.users.findOne({ gatewayUserId });
		assert(created);
		expect(foldPendingStrays).toHaveBeenCalledWith(created._id, [strayId]);

		await collections.users.deleteOne({ _id: created._id });
		await collections.sessions.deleteMany({ userId: created._id });
		await collections.settings.deleteMany({ userId: created._id });
	});

	it("updates the resolved target in place and does not fold anything", async () => {
		const gatewayUserId = `gw-existing-${new ObjectId().toString()}`;
		const { insertedId } = await collections.users.insertOne({
			_id: new ObjectId(),
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "old name",
			hfUserId: "irrelevant-on-a-gateway-preset",
			gatewayUserId,
		} as never);
		resolveGatewayLogin.mockResolvedValueOnce({
			user: await collections.users.findOne({ _id: insertedId }),
			gatewayUserId,
			pendingStrays: [],
		});

		const locals = { sessionId: new ObjectId().toString() } as unknown as App.Locals;
		await updateUser({ userData, token, locals, cookies: cookiesMock });

		const updated = await collections.users.findOne({ _id: insertedId });
		expect(updated?.name).toBe(userData.name);
		expect(updated?.hfUserId).toBe(userData.sub);
		expect(foldPendingStrays).not.toHaveBeenCalled();

		await collections.users.deleteOne({ _id: insertedId });
		await collections.sessions.deleteMany({ userId: insertedId });
	});

	it("fails the login closed and never touches the database when the gateway refuses", async () => {
		resolveGatewayLogin.mockRejectedValueOnce(
			new GatewayLoginError(403, "This account is not enabled here.")
		);
		const countBefore = await collections.users.countDocuments({});

		const locals = { sessionId: new ObjectId().toString() } as unknown as App.Locals;
		await expect(
			updateUser({ userData, token, locals, cookies: cookiesMock })
		).rejects.toMatchObject({ status: 403 });

		expect(await collections.users.countDocuments({})).toBe(countBefore);
	});
});
