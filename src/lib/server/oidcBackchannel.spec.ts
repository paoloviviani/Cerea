import { describe, expect, it } from "vitest";
import {
	discoverViaInternal,
	forwardedHeaders,
	toInternal,
	withForwardedHeaders,
} from "./oidcBackchannel";

const PUBLIC = "https://llm.example.org/authelia";
const INTERNAL = "http://authelia:9091/authelia";

function fakeIdp(honour = true) {
	const seen: Array<{ url: string; headers: Record<string, string> }> = [];
	const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const headers = Object.fromEntries(new Headers(init?.headers).entries());
		seen.push({ url: String(input), headers });
		const issuer =
			honour && headers["x-forwarded-host"]
				? `${headers["x-forwarded-proto"]}://${headers["x-forwarded-host"]}/authelia`
				: INTERNAL;
		return new Response(
			JSON.stringify({
				issuer,
				authorization_endpoint: `${issuer}/api/oidc/authorization`,
				token_endpoint: `${issuer}/api/oidc/token`,
				jwks_uri: `${issuer}/jwks.json`,
				userinfo_endpoint: `${issuer}/api/oidc/userinfo`,
				end_session_endpoint: `${issuer}/logout`,
			}),
			{ status: 200, headers: { "content-type": "application/json" } }
		);
	}) as typeof fetch;
	return { impl, seen };
}

describe("oidcBackchannel", () => {
	it("names the public origin in forwarded headers, port included", () => {
		expect(forwardedHeaders("https://10.0.0.5:18443/authelia")).toEqual({
			"x-forwarded-proto": "https",
			"x-forwarded-host": "10.0.0.5:18443",
		});
	});

	it("only rewrites endpoints under the public issuer", () => {
		expect(toInternal(`${PUBLIC}/jwks.json`, PUBLIC, INTERNAL)).toBe(`${INTERNAL}/jwks.json`);
		expect(toInternal("https://cdn.example.net/keys", PUBLIC, INTERNAL)).toBe(
			"https://cdn.example.net/keys"
		);
		expect(toInternal(undefined, PUBLIC, INTERNAL)).toBeUndefined();
	});

	it("discovers through the internal URL and keeps browser endpoints public", async () => {
		const idp = fakeIdp();
		const metadata = await discoverViaInternal(PUBLIC, INTERNAL, idp.impl);
		expect(idp.seen[0].url).toBe(`${INTERNAL}/.well-known/openid-configuration`);
		expect(idp.seen[0].headers["x-forwarded-host"]).toBe("llm.example.org");
		expect(metadata.issuer).toBe(PUBLIC);
		expect(metadata.token_endpoint).toBe(`${INTERNAL}/api/oidc/token`);
		expect(metadata.jwks_uri).toBe(`${INTERNAL}/jwks.json`);
		expect(metadata.userinfo_endpoint).toBe(`${INTERNAL}/api/oidc/userinfo`);
		expect(metadata.authorization_endpoint).toBe(`${PUBLIC}/api/oidc/authorization`);
		expect(metadata.end_session_endpoint).toBe(`${PUBLIC}/logout`);
	});

	it("names ignored forwarded headers as the cause", async () => {
		await expect(discoverViaInternal(PUBLIC, INTERNAL, fakeIdp(false).impl)).rejects.toThrow(
			/did not honour X-Forwarded/
		);
	});

	it("gives openid-client only the forwarded headers, for it to merge", () => {
		const hook = withForwardedHeaders(PUBLIC);
		const out = hook(new URL(`${INTERNAL}/api/oidc/token`), {
			headers: { authorization: "Basic x" },
		});
		expect(out).toEqual({
			headers: { "x-forwarded-proto": "https", "x-forwarded-host": "llm.example.org" },
		});
	});
});
