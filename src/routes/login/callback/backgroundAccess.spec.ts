/**
 * The sign-in callback's handling of background access (`offline_access`): the retry when an IdP's
 * client does not allow it, the one-off retry for Authelia's first remembered consent, settling the
 * browser's cookie once a grant exists, and the single extra round that restores a missing grant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRedirect } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";

const mocks = vi.hoisted(() => ({
	validate: vi.fn(),
	userData: vi.fn(),
	available: vi.fn(),
}));

vi.mock("$lib/server/auth", async (original) => ({
	...(await original<typeof import("$lib/server/auth")>()),
	validateAndParseCsrfToken: mocks.validate,
	getOIDCUserData: mocks.userData,
	offlineAccessAvailable: mocks.available,
}));
vi.mock("./updateUser.js", async (original) => ({
	...(await original<typeof import("./updateUser.js")>()),
	updateUser: vi.fn(),
}));

import { BACKGROUND_COOKIE } from "$lib/server/auth";
import { saveGrant } from "$lib/server/schedules/grants";
import { GET } from "./+server";

await ready;

function cookieJar(initial: Record<string, string> = {}) {
	const jar = new Map(Object.entries({ "hfChat-codeVerifier": "verifier", ...initial }));
	return {
		jar,
		get: (name: string) => jar.get(name),
		set: (name: string, value: string) => void jar.set(name, value),
		delete: (name: string) => void jar.delete(name),
	};
}

async function call(query: string, jar = cookieJar(), sessionId = "s1") {
	const url = new URL(`http://localhost/login/callback?${query}`);
	const result = await GET({
		url,
		locals: { sessionId, isAdmin: false },
		cookies: jar,
		request: new Request(url),
		getClientAddress: () => "127.0.0.1",
	} as never).then(
		(response) => ({ response }),
		(thrown) => ({ thrown })
	);
	const thrown = (result as { thrown?: unknown }).thrown;
	return {
		jar,
		redirectedTo: isRedirect(thrown) ? (thrown as { location: string }).location : undefined,
		failed: thrown && !isRedirect(thrown) ? (thrown as { status?: number }) : undefined,
	};
}

const state = Buffer.from("{}").toString("base64");

beforeEach(async () => {
	vi.clearAllMocks();
	await collections.sessions.deleteMany({});
	await collections.scheduleGrants.deleteMany({});
	mocks.validate.mockResolvedValue({
		redirectUrl: "http://localhost/login/callback",
		next: "/schedules?new=1",
	});
	mocks.userData.mockResolvedValue({
		userData: { sub: "sub-ada" },
		token: { access_token: "at" },
	});
	mocks.available.mockResolvedValue(true);
});

async function signedIn(withGrant: boolean) {
	const userId = new ObjectId();
	await collections.sessions.insertOne({
		_id: new ObjectId(),
		sessionId: "s1",
		userId,
		createdAt: new Date(),
		updatedAt: new Date(),
		expiresAt: new Date(Date.now() + 3600_000),
	} as never);
	if (withGrant) await saveGrant(userId, { refresh_token: "rt", access_token: "at" } as never);
	return userId;
}

describe("an error on a sign-in that asked for offline_access", () => {
	const offlineState = () =>
		mocks.validate.mockResolvedValue({
			redirectUrl: "http://localhost/login/callback",
			next: "/chats",
			offline: true,
		});

	it.each(["invalid_scope", "access_denied", "server_error"])(
		"%s falls back to a plain sign-in, once, marking the browser so it is not asked again",
		async (error) => {
			offlineState();
			const { jar, redirectedTo, failed } = await call(`error=${error}&state=${state}`);
			expect(failed).toBeUndefined();
			expect(redirectedTo).toBe("/login?next=%2Fchats");
			expect(jar.get(BACKGROUND_COOKIE)).toBe("0");
		}
	);

	it("repeated errors cannot loop: the browser's cookie makes the next sign-in plain", async () => {
		offlineState();
		const first = await call(`error=server_error&state=${state}`);
		expect(first.jar.get(BACKGROUND_COOKIE)).toBe("0");
		// A plain sign-in carries no offline flag: a repeat gets the one ordinary retry, then it is an error.
		mocks.validate.mockResolvedValue({ redirectUrl: "http://localhost/login/callback" });
		const again = await call(`error=server_error&state=${state}`, first.jar);
		expect(again.redirectedTo).toBe("/login");
		const last = await call(`error=server_error&state=${state}`, again.jar);
		expect(last.failed?.status).toBe(400);
	});

	it("during the extra round for a missing grant, a person already signed in goes back where they were", async () => {
		offlineState();
		await signedIn(false);
		const { jar, redirectedTo } = await call(`error=access_denied&state=${state}`);
		expect(redirectedTo).toBe("/chats");
		expect(jar.get(BACKGROUND_COOKIE)).toBe("0");
	});

	it("a crafted error on someone's own plain state changes nothing for anyone else", async () => {
		mocks.validate.mockResolvedValue({ redirectUrl: "http://localhost/login/callback" });
		const { jar, failed } = await call(`error=invalid_scope&state=${state}`);
		expect(failed?.status).toBe(400);
		expect(jar.get(BACKGROUND_COOKIE)).toBeUndefined();
		// And nothing process-wide was learned: another browser still asks for offline_access.
		const { loginScopes } = await import("$lib/server/auth");
		expect(loginScopes(["openid", "offline_access"]).offline).toBe(true);
	});
});

describe("Authelia's first remembered consent", () => {
	it("answers a server_error once by signing in again, keeping the way back, and not twice", async () => {
		const first = await call(`error=server_error&state=${state}`);
		expect(first.redirectedTo).toBe("/login?next=%2Fschedules%3Fnew%3D1");
		const second = await call(`error=server_error&state=${state}`, first.jar);
		expect(second.failed?.status).toBe(400);
	});
});

describe("settling background access after the sign-in", () => {
	it("a person with a grant settles the browser: no more offline_access asked here", async () => {
		await signedIn(true);
		const { jar, redirectedTo } = await call(`code=c&state=${state}`);
		expect(jar.get(BACKGROUND_COOKIE)).toBe("1");
		expect(redirectedTo).toBe("/schedules?new=1");
	});

	it("a person with none gets one extra round that asks for it, and keeps the way back", async () => {
		await signedIn(false);
		const { redirectedTo } = await call(`code=c&state=${state}`);
		expect(redirectedTo).toBe("/login?offline=1&next=%2Fschedules%3Fnew%3D1");
	});

	it("that round is not repeated when it brought nothing back: the browser is marked and goes on", async () => {
		await signedIn(false);
		mocks.validate.mockResolvedValue({
			redirectUrl: "http://localhost/login/callback",
			next: "/chats",
			offline: true,
		});
		const { jar, redirectedTo } = await call(`code=c&state=${state}`);
		expect(jar.get(BACKGROUND_COOKIE)).toBe("0");
		expect(redirectedTo).toBe("/chats");
	});

	it("a browser marked as having none is not asked again", async () => {
		await signedIn(false);
		const { redirectedTo } = await call(
			`code=c&state=${state}`,
			cookieJar({ [BACKGROUND_COOKIE]: "0" })
		);
		expect(redirectedTo).toBe("/schedules?new=1");
	});

	it("an issuer that offers nothing to ask for is not asked", async () => {
		await signedIn(false);
		mocks.available.mockResolvedValue(false);
		const { redirectedTo } = await call(`code=c&state=${state}`);
		expect(redirectedTo).toBe("/schedules?new=1");
	});

	it("a grant that went missing under a marked browser is asked for again", async () => {
		await signedIn(false);
		const { redirectedTo } = await call(
			`code=c&state=${state}`,
			cookieJar({ [BACKGROUND_COOKIE]: "1" })
		);
		expect(redirectedTo).toBe("/login?offline=1&next=%2Fschedules%3Fnew%3D1");
	});
});
