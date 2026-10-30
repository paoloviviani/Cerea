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

import {
	_resetOfflineAccessRefused,
	BACKGROUND_COOKIE,
	offlineAccessWasRefused,
} from "$lib/server/auth";
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
	_resetOfflineAccessRefused();
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

describe("a client that does not allow offline_access", () => {
	it("signs in again without it, once, remembering that this issuer refuses it", async () => {
		mocks.validate.mockResolvedValue({
			redirectUrl: "http://localhost/login/callback",
			next: "/chats",
			offline: true,
		});
		const first = await call(`error=invalid_scope&state=${state}`);
		expect(first.redirectedTo).toBe("/login?next=%2Fchats");
		expect(offlineAccessWasRefused()).toBe(true);

		// Refused already: a second invalid_scope is a real error, not a loop.
		const second = await call(`error=invalid_scope&state=${state}`);
		expect(second.failed?.status).toBe(400);
	});

	it("is a plain error when offline_access was not what was asked", async () => {
		mocks.validate.mockResolvedValue({ redirectUrl: "http://localhost/login/callback" });
		const result = await call(`error=invalid_scope&state=${state}`);
		expect(result.failed?.status).toBe(400);
		expect(offlineAccessWasRefused()).toBe(false);
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
