import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RequestHandler } from "@sveltejs/kit";
import { testRequest } from "$lib/server/__tests__/testRequest";

/**
 * `ALLOWED_USER_EMAILS`/`ALLOWED_USER_DOMAINS` gate who may sign in at all
 * (+server.ts), reading the same `userData.email` that `updateUser.ts` now
 * validates with a looser schema (admin@local support, ADR 0068's IdP). This
 * file exists because that gate had no test coverage of its own: a change
 * that reshaped or normalised the email value anywhere upstream could
 * silently loosen admission, and nothing would fail. `+server.ts` itself is
 * untouched by the schema fix — this pins that its behaviour really is
 * unchanged, rather than assuming it from the diff.
 *
 * Note what these cases deliberately do NOT cover: `admin@local` itself as a
 * *configured* entry. `allowedUserEmails`/`allowedUserDomains` are parsed
 * with `z.string().email()` / a dotted-domain regex at module load, and
 * `admin@local` (and bare `local`) fail both — a deployment that tried to
 * list it in either variable would 500 on load, for every login, not just
 * the admin's. That is a pre-existing gap in this file, untouched by the
 * fix this suite guards, and out of scope here since this deployment leaves
 * both variables empty (`Cerea/.env`); it does not affect the fix, only a
 * configuration nobody has set.
 *
 * The gate is read once at module load (`allowedUserEmails`/
 * `allowedUserDomains` are top-level consts), so each scenario needs its own
 * fresh module graph: `vi.resetModules()` plus a re-mocked config, then a
 * dynamic re-import of the route.
 */

const authMock = vi.hoisted(() => ({
	validateAndParseCsrfToken: vi.fn(),
	getOIDCUserData: vi.fn(),
}));

vi.mock("$lib/server/auth", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/auth")>();
	return {
		...actual,
		validateAndParseCsrfToken: authMock.validateAndParseCsrfToken,
		getOIDCUserData: authMock.getOIDCUserData,
	};
});

vi.mock("./updateUser.js", () => ({ updateUser: vi.fn() }));

const csrfState = Buffer.from("test-csrf-payload").toString("base64");

let importCounter = 0;

async function loadHandler(env: { emails?: string; domains?: string }) {
	vi.resetModules();
	vi.doMock("$lib/server/config", async (importOriginal) => {
		const actual = await importOriginal<typeof import("$lib/server/config")>();
		return {
			...actual,
			config: new Proxy(actual.config, {
				get(target, prop, receiver) {
					if (prop === "ALLOWED_USER_EMAILS") return env.emails ?? "[]";
					if (prop === "ALLOWED_USER_DOMAINS") return env.domains ?? "[]";
					return Reflect.get(target, prop, receiver);
				},
			}),
		};
	});
	const mod = await import(/* @vite-ignore */ `./+server?t=${++importCounter}`);
	return mod.GET as RequestHandler;
}

async function callCallback(
	userData: Record<string, unknown>,
	env: { emails?: string; domains?: string }
) {
	authMock.validateAndParseCsrfToken.mockResolvedValue({
		redirectUrl: "http://localhost:5173/login/callback",
		next: undefined,
	});
	authMock.getOIDCUserData.mockResolvedValue({
		userData,
		token: { access_token: "at", expires_at: Math.floor(Date.now() / 1000) + 3600 },
	});

	const GET = await loadHandler(env);

	return testRequest(GET, {
		path: `/login/callback?code=abc&state=${csrfState}`,
		headers: { cookie: "hfChat-codeVerifier=verifier" },
	});
}

beforeEach(() => {
	authMock.validateAndParseCsrfToken.mockReset();
	authMock.getOIDCUserData.mockReset();
});

describe("login callback: ALLOWED_USER_EMAILS / ALLOWED_USER_DOMAINS gate", () => {
	it("allows anyone when neither restriction is configured", async () => {
		const res = await callCallback({ sub: "1", email: "nobody@nowhere.example" }, {});
		expect(res.status).toBe(302);
	});

	it("allows an exact match in ALLOWED_USER_EMAILS", async () => {
		const res = await callCallback(
			{ sub: "1", email: "person@example.org" },
			{ emails: JSON.stringify(["person@example.org"]) }
		);
		expect(res.status).toBe(302);
	});

	it("rejects an email absent from both lists", async () => {
		const res = await callCallback(
			{ sub: "1", email: "someone@else.example" },
			{ emails: JSON.stringify(["person@example.org"]) }
		);
		expect(res.status).toBe(403);
	});

	it("allows a domain match in ALLOWED_USER_DOMAINS even without an email-list entry", async () => {
		const res = await callCallback(
			{ sub: "1", email: "person@example.org" },
			{ domains: JSON.stringify(["example.org"]) }
		);
		expect(res.status).toBe(302);
	});

	it("rejects a response with no email when a restriction is configured", async () => {
		const res = await callCallback(
			{ sub: "1" },
			{ emails: JSON.stringify(["person@example.org"]) }
		);
		expect(res.status).toBe(403);
	});

	it("rejects an unverified email even if it matches the allow list", async () => {
		const res = await callCallback(
			{ sub: "1", email: "person@example.org", email_verified: false },
			{ emails: JSON.stringify(["person@example.org"]) }
		);
		expect(res.status).toBe(403);
	});

	it("treats an absent email_verified claim as verified, matching the historical default", async () => {
		const res = await callCallback(
			{ sub: "1", email: "person@example.org" },
			{ emails: JSON.stringify(["person@example.org"]) }
		);
		expect(res.status).toBe(302);
	});
});
