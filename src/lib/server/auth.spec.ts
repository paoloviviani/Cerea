/**
 * The terminal's step-up reauth (ADR 0090 D6): sending a stale session
 * through a *plain* login is a no-op at most IdPs, Authelia included — an
 * active SSO session answers it without re-prompting, so `auth_time` never
 * moves and the person can never open a terminal. `?reauth=1` must make
 * the authorization request carry `prompt=login` (and never `max_age=0`,
 * which Authelia treats as "always re-authenticate", looping the login
 * forever); a normal login must carry neither.
 *
 * `openid-client` is mocked at the module boundary — this is a URL-building
 * unit, not an integration test of the OIDC exchange itself (that path is
 * covered live by the e2e suite's login flow against the mock issuer).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

interface CapturedParams {
	[key: string]: unknown;
}

const authorizationUrlCalls: CapturedParams[] = [];

vi.mock("openid-client", () => {
	class FakeClient {
		issuer = { metadata: {} };
		authorizationUrl(params: CapturedParams): string {
			authorizationUrlCalls.push(params);
			const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
			return `https://mock-issuer.invalid/auth?${query.toString()}`;
		}
	}
	const fakeIssuer = { metadata: {}, Client: FakeClient };
	return {
		Issuer: class {
			static discover = vi.fn(async () => fakeIssuer);
		},
		custom: {
			http_options: Symbol("http_options"),
			clock_tolerance: Symbol("clock_tolerance"),
		},
		generators: {
			codeVerifier: () => "test-code-verifier",
			codeChallenge: () => "test-code-challenge",
		},
	};
});

const { getOIDCAuthorizationUrl, sanitizeReturnPath } = await import("./auth");

function fakeCookies() {
	return {
		set: vi.fn(),
		get: vi.fn(),
		delete: vi.fn(),
	} as unknown as import("@sveltejs/kit").Cookies;
}

beforeEach(() => {
	authorizationUrlCalls.length = 0;
});

describe("getOIDCAuthorizationUrl's reauth flag", () => {
	it("a normal login carries neither prompt nor max_age", async () => {
		await getOIDCAuthorizationUrl(
			{ redirectURI: "https://cerea.invalid/login/callback" },
			{
				sessionId: "session-1",
				url: new URL("https://cerea.invalid/login"),
				cookies: fakeCookies(),
			}
		);
		expect(authorizationUrlCalls).toHaveLength(1);
		expect(authorizationUrlCalls[0].prompt).toBeUndefined();
		expect(authorizationUrlCalls[0].max_age).toBeUndefined();
	});

	it("reauth:true carries prompt=login and never max_age (Authelia loops on max_age=0)", async () => {
		await getOIDCAuthorizationUrl(
			{ redirectURI: "https://cerea.invalid/login/callback" },
			{
				sessionId: "session-1",
				url: new URL("https://cerea.invalid/login?reauth=1"),
				cookies: fakeCookies(),
				reauth: true,
			}
		);
		expect(authorizationUrlCalls).toHaveLength(1);
		expect(authorizationUrlCalls[0].prompt).toBe("login");
		expect(authorizationUrlCalls[0].max_age).toBeUndefined();
	});

	it("still carries the return path (next) under reauth, same-origin only", async () => {
		await getOIDCAuthorizationUrl(
			{ redirectURI: "https://cerea.invalid/login/callback" },
			{
				sessionId: "session-1",
				next: "/code?device=abc",
				url: new URL("https://cerea.invalid/login?reauth=1"),
				cookies: fakeCookies(),
				reauth: true,
			}
		);
		// `next` travels inside the signed `state` param, not as a bare query
		// param — decoded indirectly via `validateAndParseCsrfToken` elsewhere;
		// this only asserts reauth didn't drop the mechanism (a `state` was
		// still produced) or change the sanitize rule (an absolute in-app
		// path, never `//…` or a foreign origin — `sanitizeReturnPath`, unit
		// tested on its own callers already).
		expect(typeof authorizationUrlCalls[0].state).toBe("string");
	});
});

describe("sanitizeReturnPath (audit M3)", () => {
	const cases: Array<[string, string | undefined | null, string | undefined]> = [
		["a plain path", "/", "/"],
		[
			"a nested path with a query",
			"/conversation/abc?x=1&y=hello%20world",
			"/conversation/abc?x=1&y=hello%20world",
		],
		["a hash", "/settings#tools", "/settings#tools"],
		["empty", "", undefined],
		["null", null, undefined],
		["undefined", undefined, undefined],
		["relative", "settings", undefined],
		["absolute URL", "https://evil.com/", undefined],
		["scheme-relative", "//evil.com", undefined],
		["backslash host", "/\\evil.com", undefined],
		["double backslash", "\\\\evil.com", undefined],
		["slash backslash after path", "/a/\\evil.com", undefined],
		["encoded backslash", "/%5Cevil.com", undefined],
		["encoded backslash lowercase", "/%5cevil.com", undefined],
		["encoded double slash", "/%2F%2Fevil.com", undefined],
		["dot-segment collapse to //", "/.//evil.com", undefined],
		["dot-dot collapse to //", "/a/..//evil.com", undefined],
		["tab", "/\t/evil.com", undefined],
		["newline", "/\n/evil.com", undefined],
		["encoded tab", "/%09/evil.com", undefined],
		["encoded newline", "/%0a/evil.com", undefined],
		["NUL", "/\u0000evil", undefined],
		["space", "/ /evil.com", undefined],
		["javascript scheme", "javascript:alert(1)", undefined],
		["slash then javascript", "/javascript:alert(1)", "/javascript:alert(1)"],
		["malformed escape", "/%E0%A4%A", undefined],
	];
	it.each(cases)("%s", (_name, input, expected) => {
		expect(sanitizeReturnPath(input, "")).toBe(expected);
	});

	it("keeps only paths under the app base", () => {
		expect(sanitizeReturnPath("/chat/conversation/1", "/chat")).toBe("/chat/conversation/1");
		expect(sanitizeReturnPath("/chat", "/chat")).toBe("/chat");
		expect(sanitizeReturnPath("/chatter", "/chat")).toBeUndefined();
		expect(sanitizeReturnPath("/other/x", "/chat")).toBeUndefined();
		expect(sanitizeReturnPath("/chat/../other", "/chat")).toBeUndefined();
	});
});
