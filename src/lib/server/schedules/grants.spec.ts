/**
 * The per-person background grant shared by browser sessions and scheduled runs: what a login
 * writes, how a rotation race is avoided (the IdP here really refuses a refresh token it has
 * already rotated), what a refused grant does, and that the path for an IdP that issues no refresh
 * token is the one it always was.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { open } from "$lib/server/mcp/secretBox";

/** An identity provider that rotates refresh tokens and refuses one it has already rotated. */
const idp = vi.hoisted(() => ({
	current: "rt-1",
	n: 0,
	calls: [] as string[],
	refuse: false,
	revoked: [] as string[],
}));

// The IdP is faked below the app's own OIDC code (`openid-client`'s issuer and client), so the
// real `getOIDCClient`, `refreshOAuthToken` and `revokeOAuthToken` run.
vi.mock("openid-client", async (original) => {
	const real = await original<typeof import("openid-client")>();
	class FakeClient {
		issuer = { metadata: { revocation_endpoint: "https://idp.invalid/revoke" } };
		async refresh(presented: string) {
			idp.calls.push(presented);
			await new Promise((r) => setTimeout(r, 40));
			if (idp.refuse || presented !== idp.current) {
				throw Object.assign(new Error("invalid_grant"), { error: "invalid_grant" });
			}
			idp.n += 1;
			idp.current = `rt-${idp.n + 1}`;
			return {
				access_token: `at-${idp.n}`,
				refresh_token: idp.current,
				expires_at: Math.floor((Date.now() + 3600_000) / 1000),
			};
		}
		async revoke(token: string) {
			idp.revoked.push(token);
		}
	}
	const issuer = {
		metadata: { revocation_endpoint: "https://idp.invalid/revoke", scopes_supported: [] },
		Client: FakeClient,
	};
	return { ...real, Issuer: Object.assign(function () {}, { discover: async () => issuer }) };
});

import { findUser } from "$lib/server/auth";
import { updateUser } from "../../../routes/login/callback/updateUser";
import { accessTokenFor, hasGrant, SIGN_IN_AGAIN } from "./grants";

await ready;

const cookies = { set: vi.fn(), get: vi.fn(), delete: vi.fn() } as never;
const claims = { preferred_username: "ada", name: "Ada", sub: "sub-ada" };
const url = new URL("http://localhost/");

function tokens(refresh: string | undefined, access: string, ageMs = 3600_000) {
	return {
		access_token: access,
		...(refresh ? { refresh_token: refresh } : {}),
		expires_at: Math.floor((Date.now() + ageMs) / 1000),
		claims: () => ({}),
	} as never;
}

async function login(
	over: { refresh?: string; access?: string; sessionId?: string; ageMs?: number } = {}
) {
	const sessionId = over.sessionId ?? `s-${new ObjectId().toString()}`;
	await updateUser({
		userData: claims,
		token: tokens(over.refresh ?? "rt-1", over.access ?? "at-login", over.ageMs),
		locals: { sessionId, isAdmin: false },
		cookies,
	});
	// `updateUser` re-keys the session by a fresh secret: find it by its owner.
	const user = await collections.users.findOne({ hfUserId: "sub-ada" });
	if (!user) throw new Error("the login made no user");
	const sessions = await collections.sessions.find({ userId: user._id }).toArray();
	return { user, sessions };
}

beforeEach(async () => {
	await cleanupTestData();
	await collections.scheduleGrants.deleteMany({});
	await collections.schedules.deleteMany({});
	idp.current = "rt-1";
	idp.n = 0;
	idp.calls = [];
	idp.refuse = false;
	idp.revoked = [];
});

async function chatSchedule(userId: ObjectId, name = "s") {
	const _id = new ObjectId();
	await collections.schedules.insertOne({
		_id,
		userId,
		kind: "chat",
		name,
		target: {},
		prompt: "p",
		recurrence: { type: "daily", at: "09:00" },
		timezone: "UTC",
		anchorAt: new Date(),
		enabled: true,
		nextRunAt: new Date(Date.now() + 3600_000),
		consecutiveFailures: 0,
		firedCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id;
}

describe("what a login writes", () => {
	it("keeps the refresh token sealed as the person's grant, with its subject, and gives the session none of its own", async () => {
		const { user, sessions } = await login({ refresh: "rt-1" });

		const grant = await collections.scheduleGrants.findOne({ userId: user._id });
		expect(open(grant?.refreshSealed ?? "")).toBe("rt-1");
		expect(grant?.refreshSealed).not.toContain("rt-1");
		expect(grant).toMatchObject({ sub: "sub-ada" });
		expect(grant?.issuedAt).toBeInstanceOf(Date);
		expect(sessions).toHaveLength(1);
		expect(sessions[0].oauth?.refreshToken).toBeUndefined();
		expect(sessions[0].oauth?.token?.value).toBe("at-login");
	});

	it("the newest login's refresh token replaces the older one, whatever other device holds", async () => {
		await login({ refresh: "rt-1" });
		const { user, sessions } = await login({ refresh: "rt-9", access: "at-9" });

		expect(await collections.scheduleGrants.countDocuments({ userId: user._id })).toBe(1);
		const grant = await collections.scheduleGrants.findOne({ userId: user._id });
		expect(open(grant?.refreshSealed ?? "")).toBe("rt-9");
		expect(open(grant?.accessSealed ?? "")).toBe("at-9");
		expect(sessions).toHaveLength(2);
		expect(sessions.every((s) => s.oauth?.refreshToken === undefined)).toBe(true);
	});

	it("an IdP that issues no refresh token leaves no grant, and the session is exactly what it was", async () => {
		const { user, sessions } = await login({ refresh: "" });

		expect(await hasGrant(user._id)).toBe(false);
		expect(sessions[0].oauth).toMatchObject({ token: { value: "at-login" } });
		expect(sessions[0].oauth?.refreshToken).toBeFalsy();
		// And an expired session of such a person ends, as it always did.
		await collections.sessions.updateOne(
			{ _id: sessions[0]._id },
			{ $set: { "oauth.token.expiresAt": new Date(Date.now() - 1000) } }
		);
		const found = await findUser(sessions[0].sessionId, undefined, url);
		expect(found).toMatchObject({ user: null, invalidateSession: true });
		expect(idp.calls).toEqual([]);
	});

	it("without CHAT_SECRET_KEY the grant cannot be kept, and the session keeps its own refresh token", async () => {
		const saved = process.env.CHAT_SECRET_KEY;
		delete process.env.CHAT_SECRET_KEY;
		try {
			const { user, sessions } = await login({ refresh: "rt-own" });
			expect(await hasGrant(user._id)).toBe(false);
			expect(sessions[0].oauth?.refreshToken).toBe("rt-own");
		} finally {
			process.env.CHAT_SECRET_KEY = saved;
		}
	});
});

describe("refreshing without a stale token", () => {
	/** Two browser sessions of one person, both about to run out of access. */
	async function twoSessionsNearExpiry() {
		await login({ refresh: "rt-1", access: "at-a", ageMs: 2 * 60_000 });
		const { user, sessions } = await login({ refresh: "rt-1", access: "at-b", ageMs: 2 * 60_000 });
		// The second login replaced the grant with the same token; the IdP knows only "rt-1".
		return { user, sessions };
	}

	it("two sessions and a scheduled run asking at once share one refresh: nobody presents a rotated token", async () => {
		const { user, sessions } = await twoSessionsNearExpiry();
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() + 60_000) } }
		);

		const [a, b, run] = await Promise.all([
			findUser(sessions[0].sessionId, undefined, url),
			findUser(sessions[1].sessionId, undefined, url),
			accessTokenFor(user._id),
		]);

		expect(a.invalidateSession).toBe(false);
		expect(b.invalidateSession).toBe(false);
		expect(idp.calls).toEqual(["rt-1"]);
		expect(a.oauth?.token?.value).toBe("at-1");
		expect(b.oauth?.token?.value).toBe("at-1");
		expect(run.value).toBe("at-1");
		const grant = await collections.scheduleGrants.findOne({ userId: user._id });
		expect(open(grant?.refreshSealed ?? "")).toBe("rt-2");
	});

	it("the next refresh, by anyone, uses the rotated token and rotates again", async () => {
		const { user } = await twoSessionsNearExpiry();
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		await accessTokenFor(user._id);
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		expect((await accessTokenFor(user._id)).value).toBe("at-2");
		expect(idp.calls).toEqual(["rt-1", "rt-2"]);
	});

	it("a session reuses the access token a run just refreshed, instead of refreshing again", async () => {
		const { user, sessions } = await twoSessionsNearExpiry();
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		await accessTokenFor(user._id);
		const found = await findUser(sessions[0].sessionId, undefined, url);
		expect(found.oauth?.token?.value).toBe("at-1");
		expect(idp.calls).toEqual(["rt-1"]);
	});
});

describe("a refused grant", () => {
	it("ends the session, drops the grant, revokes it at the IdP and switches the chat schedules off", async () => {
		const { user, sessions } = await login({ refresh: "rt-1", ageMs: 60_000 });
		const a = await chatSchedule(user._id, "a");
		const b = await chatSchedule(user._id, "b");
		idp.refuse = true;
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);

		const found = await findUser(sessions[0].sessionId, undefined, url);

		expect(found).toMatchObject({ user: null, invalidateSession: true });
		expect(await hasGrant(user._id)).toBe(false);
		expect(idp.revoked).toEqual(["rt-1"]);
		for (const _id of [a, b]) {
			expect(await collections.schedules.findOne({ _id })).toMatchObject({
				enabled: false,
				nextRunAt: null,
				disabledReason: SIGN_IN_AGAIN,
			});
		}
	});

	it("the next login restores the grant; the schedules stay off until they are turned on", async () => {
		const { user } = await login({ refresh: "rt-1", ageMs: 60_000 });
		const _id = await chatSchedule(user._id);
		idp.refuse = true;
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		await expect(accessTokenFor(user._id)).rejects.toThrow(SIGN_IN_AGAIN);

		idp.refuse = false;
		await login({ refresh: "rt-new" });
		expect(await hasGrant(user._id)).toBe(true);
		expect((await collections.schedules.findOne({ _id }))?.enabled).toBe(false);
	});

	it("an IdP that cannot be reached is an ordinary error: the grant and the schedules stay", async () => {
		const { user } = await login({ refresh: "rt-1" });
		const _id = await chatSchedule(user._id);
		await collections.scheduleGrants.updateOne(
			{ userId: user._id },
			{ $set: { accessExpiresAt: new Date(Date.now() - 1000) } }
		);
		const mod = await import("$lib/server/auth");
		const spy = vi
			.spyOn(mod, "refreshOAuthToken")
			.mockRejectedValue(new Error("connect ECONNREFUSED"));
		await expect(accessTokenFor(user._id)).rejects.toThrow("ECONNREFUSED");
		spy.mockRestore();
		expect(await hasGrant(user._id)).toBe(true);
		expect((await collections.schedules.findOne({ _id }))?.enabled).toBe(true);
	});
});

describe("signing out", () => {
	it("one device's logout deletes its session and keeps the grant", async () => {
		const { POST } = await import("../../../routes/logout/+server");
		const { user, sessions } = await login({ refresh: "rt-1" });
		await login({ refresh: "rt-2" });

		await POST({
			locals: { sessionId: sessions[0].sessionId, isAdmin: false },
			cookies,
			url,
		} as never).catch(() => undefined);

		expect(await collections.sessions.countDocuments({ sessionId: sessions[0].sessionId })).toBe(0);
		expect(await hasGrant(user._id)).toBe(true);
		expect(
			open((await collections.scheduleGrants.findOne({ userId: user._id }))?.refreshSealed ?? "")
		).toBe("rt-2");
	});
});

describe("a person without an account here", () => {
	it("has no grant to refresh", async () => {
		const stranger = (await createTestUser()).user;
		await expect(accessTokenFor(stranger._id)).rejects.toThrow(/Sign in again/);
	});
});
