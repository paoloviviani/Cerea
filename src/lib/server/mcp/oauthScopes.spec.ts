/** Scopes and the Google rules, as they reach the authorization URL and the token calls. */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";

const fetchMock = vi.fn();
vi.mock("$lib/server/urlSafety", () => ({ ssrfSafeFetch: (...a: unknown[]) => fetchMock(...a) }));

beforeAll(async () => {
	await ready;
}, 30000);

function connector(over: Record<string, unknown> = {}, google = false) {
	return {
		_id: new ObjectId(),
		userId: new ObjectId(),
		scope: "user" as const,
		name: "Gmail",
		url: "https://gmailmcp.googleapis.com/mcp/v1",
		auth: "oauth" as const,
		oauth: google
			? {
					issuer: "https://accounts.google.com/",
					authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
					tokenEndpoint: "https://oauth2.googleapis.com/token",
					scopesSupported: [
						"https://mail.google.com/",
						"https://www.googleapis.com/auth/gmail.readonly",
					],
					resource: "https://gmailmcp.googleapis.com/mcp/v1",
					supportsS256: true,
				}
			: {
					issuer: "https://auth.example.com",
					authorizationEndpoint: "https://auth.example.com/authorize",
					tokenEndpoint: "https://auth.example.com/token",
					registrationEndpoint: "https://auth.example.com/register",
					scopesSupported: ["read", "write"],
					resource: "https://mcp.example.com/mcp",
					supportsS256: true,
				},
		registration: {
			clientId: "cid",
			registeredAt: new Date(),
			source: "static" as const,
		},
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	};
}

async function authorizeUrl(c: ReturnType<typeof connector>) {
	await collections.mcpConnectors.insertOne(c as never);
	const { beginAuthorization } = await import("./oauth");
	return new URL(
		await beginAuthorization({ connector: c as never, userId: c.userId, sessionId: "s" })
	);
}

describe("authorization request", () => {
	beforeEach(async () => {
		await collections.mcpConnectors.deleteMany({});
		await collections.mcpOauthPending.deleteMany({});
		fetchMock.mockReset();
	}, 20000);

	it("uses the connector's scopes when set", async () => {
		const url = await authorizeUrl(connector({ scopes: ["only-this"] }));
		expect(url.searchParams.get("scope")).toBe("only-this");
	});

	it("uses the advertised scopes when none are set", async () => {
		const url = await authorizeUrl(connector());
		expect(url.searchParams.get("scope")).toBe("read write");
		expect(url.searchParams.get("resource")).toBe("https://mcp.example.com/mcp");
		expect(url.searchParams.has("access_type")).toBe(false);
	});

	it("adds the Google parameters and no resource for Google", async () => {
		const url = await authorizeUrl(
			connector({ scopes: ["https://www.googleapis.com/auth/gmail.readonly"] }, true)
		);
		expect(url.searchParams.get("access_type")).toBe("offline");
		expect(url.searchParams.get("prompt")).toBe("consent");
		expect(url.searchParams.has("resource")).toBe(false);
		expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
	});

	it("registers dynamically with the connector's scopes", async () => {
		fetchMock.mockImplementation(() =>
			Promise.resolve(new Response(JSON.stringify({ client_id: "new" }), { status: 201 }))
		);
		const { register } = await import("./oauth");
		await register(connector({ scopes: ["narrow"] }) as never);
		expect(JSON.parse(fetchMock.mock.calls[0][1].body).scope).toBe("narrow");
		await register(connector() as never);
		expect(JSON.parse(fetchMock.mock.calls[1][1].body).scope).toBe("read write");
	});

	it("sends the secret in the form and no resource when refreshing against Google", async () => {
		const { seal } = await import("./secretBox");
		const { bearerFor } = await import("./oauth");
		const c = connector(
			{
				registration: {
					clientId: "cid",
					clientSecretSealed: seal("shh"),
					registeredAt: new Date(),
					source: "static",
				},
			},
			true
		);
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId: c._id,
			userId: c.userId,
			accessTokenSealed: seal("old"),
			refreshTokenSealed: seal("refresh-1"),
			expiresAt: new Date(Date.now() - 1000),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ access_token: "new", expires_in: 3599 }), { status: 200 })
		);
		expect(await bearerFor({ connector: c as never, userId: c.userId })).toBe("new");
		const form = new URLSearchParams(fetchMock.mock.calls[0][1].body);
		expect(form.get("client_secret")).toBe("shh");
		expect(form.get("refresh_token")).toBe("refresh-1");
		expect(form.has("resource")).toBe(false);
		// Google returns no new refresh token; the stored one must survive.
		const row = await collections.mcpTokens.findOne({ connectorId: c._id });
		expect(row?.refreshTokenSealed).toBeTruthy();
	});
});
