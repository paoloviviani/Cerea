import { describe, expect, it } from "vitest";
import {
	authorizationParams,
	isGoogle,
	parseScopes,
	requestedScopes,
	sendsResource,
	validateScopes,
} from "./providerQuirks";

// Recorded from https://gmailmcp.googleapis.com/.well-known/oauth-protected-resource/mcp/v1
// and Google's authorization-server metadata (abridged).
const GOOGLE = {
	issuer: "https://accounts.google.com/",
	authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
	tokenEndpoint: "https://oauth2.googleapis.com/token",
};
const OTHER = {
	issuer: "https://auth.example.com",
	authorizationEndpoint: "https://auth.example.com/authorize",
	tokenEndpoint: "https://auth.example.com/token",
};

describe("provider quirks", () => {
	it("asks Google for offline access and consent, and nobody else", () => {
		expect(authorizationParams(GOOGLE)).toEqual({ access_type: "offline", prompt: "consent" });
		expect(authorizationParams(OTHER)).toEqual({});
	});

	it("recognises Google by host, not by substring", () => {
		expect(isGoogle("https://accounts.google.com/")).toBe(true);
		expect(isGoogle("https://accounts.google.com.evil.test/")).toBe(false);
		expect(isGoogle("not a url")).toBe(false);
		expect(isGoogle(undefined)).toBe(false);
	});

	it("leaves the resource indicator out for Google only", () => {
		expect(sendsResource(GOOGLE)).toBe(false);
		expect(sendsResource(OTHER)).toBe(true);
	});

	it("requests the connector's scopes, else the advertised ones, else none", () => {
		const oauth = { scopesSupported: ["a", "b"] };
		expect(requestedScopes({ scopes: ["x"], oauth })).toEqual(["x"]);
		expect(requestedScopes({ scopes: [], oauth })).toEqual(["a", "b"]);
		expect(requestedScopes({ oauth })).toEqual(["a", "b"]);
		expect(requestedScopes({})).toBeUndefined();
	});

	it("parses and validates typed scopes", () => {
		expect(parseScopes(" a  b\nc,a ")).toEqual(["a", "b", "c"]);
		expect(validateScopes("")).toEqual({ scopes: [] });
		expect(validateScopes("https://www.googleapis.com/auth/gmail.readonly\nopenid")).toEqual({
			scopes: ["https://www.googleapis.com/auth/gmail.readonly", "openid"],
		});
		expect(validateScopes('bad"scope')).toHaveProperty("error");
		expect(validateScopes("x".repeat(513))).toHaveProperty("error");
		expect(validateScopes(Array.from({ length: 101 }, (_, i) => `s${i}`).join(" "))).toHaveProperty(
			"error"
		);
	});
});
