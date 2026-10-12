import { createServer, type Server } from "node:http";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { ready } from "$lib/server/database";
import { createTestUser, cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import {
	authenticateMachineRequest,
	MachineAuthError,
	resetMachineDiscoveryCacheForTests,
	validateMachineToken,
} from "./machineAuth";

/**
 * Local JWT validation (spec §3, review C1) — a locally generated keypair and
 * a local HTTP server standing in for the issuer's discovery + JWKS
 * endpoints, so these never touch a real identity provider.
 */

const ISSUER_PORT = 18999;
const ISSUER_URL = `http://127.0.0.1:${ISSUER_PORT}`;
const AUDIENCE = "pystino-api";
const CLIENT_ID = "opencode-enrollment";

let server: Server;
/** What the discovery document claims as its issuer; a test flips it to impersonate. */
let advertisedIssuer = ISSUER_URL;
/** Doorkeeper (GitLab) shape: an introspection endpoint at /oauth/introspect,
 * with token info beside it. A test turns it off to stand for any other IdP. */
let doorkeeper = true;
/** Opaque tokens the fake GitLab knows: token -> its application, owner, seconds left. */
const opaque = new Map<string, { app: string; owner: number; left: number | null }>();
let tokenInfoCalls = 0;
let privateKey: CryptoKey;
let publicJwk: Awaited<ReturnType<typeof exportJWK>>;

beforeAll(async () => {
	await ready;
	const { publicKey, privateKey: pk } = await generateKeyPair("RS256");
	privateKey = pk;
	publicJwk = await exportJWK(publicKey);
	publicJwk.alg = "RS256";
	publicJwk.use = "sig";
	publicJwk.kid = "test-key";

	server = createServer((req, res) => {
		if (req.url === "/.well-known/openid-configuration") {
			res.setHeader("content-type", "application/json");
			res.end(
				JSON.stringify({
					issuer: advertisedIssuer,
					jwks_uri: `${ISSUER_URL}/jwks`,
					userinfo_endpoint: `${ISSUER_URL}/oauth/userinfo`,
					...(doorkeeper
						? { introspection_endpoint: `${ISSUER_URL}/oauth/introspect` }
						: { introspection_endpoint: `${ISSUER_URL}/introspect` }),
				})
			);
			return;
		}
		// GitLab's Doorkeeper token info and userinfo, authorised by the token itself.
		const bearer = (req.headers.authorization ?? "").replace(/^Bearer /, "");
		const held = opaque.get(bearer);
		if (req.url === "/oauth/token/info") {
			tokenInfoCalls += 1;
			res.setHeader("content-type", "application/json");
			if (!held) {
				res.statusCode = 401;
				res.end(JSON.stringify({ error: "invalid_token" }));
				return;
			}
			res.end(
				JSON.stringify({
					resource_owner_id: held.owner,
					scope: ["openid", "profile", "email"],
					expires_in: held.left,
					application: { uid: held.app },
					created_at: Math.floor(Date.now() / 1000),
					scopes: ["openid", "profile", "email"],
					expires_in_seconds: held.left,
				})
			);
			return;
		}
		if (req.url === "/oauth/userinfo") {
			res.setHeader("content-type", "application/json");
			if (!held) {
				res.statusCode = 401;
				res.end("{}");
				return;
			}
			res.end(JSON.stringify({ sub: String(held.owner), email: "ada@example.org" }));
			return;
		}
		if (req.url === "/jwks") {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ keys: [publicJwk] }));
			return;
		}
		res.statusCode = 404;
		res.end("not found");
	});
	// `CODE_MACHINE_ISSUER`/`AUDIENCE`/`CLIENT_ID` are fixed to this exact
	// port and these exact values by `scripts/setups/vitest-setup-server.ts`'s
	// mock of `$env/dynamic/private` — that mock is snapshotted once per
	// worker, so a spec cannot override it at runtime the way it mocks a
	// network call; this server binds what the mock already promised.
	await new Promise<void>((resolve) => server.listen(ISSUER_PORT, resolve));
}, 30_000);

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
	await cleanupTestData();
});

async function signToken(
	claims: Record<string, unknown>,
	opts: { expiredBy?: number; header?: Record<string, unknown> } = {}
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	const exp = opts.expiredBy ? now - opts.expiredBy : now + 3600;
	return new SignJWT({ azp: CLIENT_ID, ...claims })
		.setProtectedHeader({ alg: "RS256", kid: "test-key", ...(opts.header ?? {}) })
		.setIssuedAt(now)
		.setIssuer(ISSUER_URL)
		.setAudience(AUDIENCE)
		.setExpirationTime(exp)
		.setSubject((claims.sub as string) ?? "user-sub")
		.sign(privateKey);
}

describe("validateMachineToken", () => {
	it("accepts a well-formed token and returns its claims", async () => {
		const token = await signToken({ sub: "hf-user-1" });
		const result = await validateMachineToken(token);
		expect(result.sub).toBe("hf-user-1");
		expect(result.iss).toBe(ISSUER_URL);
		expect(typeof result.exp).toBe("number");
	});

	it("rejects an expired token", async () => {
		const token = await signToken({ sub: "hf-user-1" }, { expiredBy: 120 });
		await expect(validateMachineToken(token)).rejects.toBeInstanceOf(MachineAuthError);
	});

	it("rejects a token with the wrong audience", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({ azp: CLIENT_ID })
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuedAt(now)
			.setIssuer(ISSUER_URL)
			.setAudience("some-other-audience")
			.setExpirationTime(now + 3600)
			.setSubject("hf-user-1")
			.sign(privateKey);
		await expect(validateMachineToken(token)).rejects.toBeInstanceOf(MachineAuthError);
	});

	it("rejects a token whose azp is not the machine client", async () => {
		const token = await signToken({ sub: "hf-user-1", azp: "some-other-client" });
		await expect(validateMachineToken(token)).rejects.toBeInstanceOf(MachineAuthError);
	});

	it("rejects a token that looks like an ID token", async () => {
		const token = await signToken({ sub: "hf-user-1" }, { header: { typ: "id_token" } });
		await expect(validateMachineToken(token)).rejects.toBeInstanceOf(MachineAuthError);
	});

	it("refuses keys from a discovery document that names another issuer", async () => {
		resetMachineDiscoveryCacheForTests();
		advertisedIssuer = "https://impostor.example";
		try {
			await expect(validateMachineToken(await signToken({}))).rejects.toThrow(/names issuer/);
		} finally {
			advertisedIssuer = ISSUER_URL;
			resetMachineDiscoveryCacheForTests();
		}
	});

	it("rejects a token from a different issuer", async () => {
		const now = Math.floor(Date.now() / 1000);
		const token = await new SignJWT({ azp: CLIENT_ID })
			.setProtectedHeader({ alg: "RS256", kid: "test-key" })
			.setIssuedAt(now)
			.setIssuer("http://not-this-issuer.example")
			.setAudience(AUDIENCE)
			.setExpirationTime(now + 3600)
			.setSubject("hf-user-1")
			.sign(privateKey);
		await expect(validateMachineToken(token)).rejects.toBeInstanceOf(MachineAuthError);
	});
});

describe("validateMachineToken with an opaque (GitLab) token", () => {
	afterEach(() => {
		opaque.clear();
		doorkeeper = true;
		tokenInfoCalls = 0;
		resetMachineDiscoveryCacheForTests();
	});

	it("accepts a token GitLab's token info says belongs to the machine client", async () => {
		opaque.set("gl-opaque-1", { app: CLIENT_ID, owner: 42, left: 7200 });
		const before = Math.floor(Date.now() / 1000);
		const validated = await validateMachineToken("gl-opaque-1");
		expect(validated.sub).toBe("42");
		expect(validated.iss).toBe(ISSUER_URL);
		expect(validated.exp).toBeGreaterThanOrEqual(before + 7199);
		expect(validated.exp).toBeLessThanOrEqual(before + 7202);
	});

	it("rejects a token issued to another application", async () => {
		opaque.set("gl-chat", { app: "the-chat-app", owner: 42, left: 7200 });
		await expect(validateMachineToken("gl-chat")).rejects.toMatchObject({ status: 401 });
	});

	it("rejects a token GitLab does not know (revoked, expired, never issued)", async () => {
		await expect(validateMachineToken("gl-unknown")).rejects.toMatchObject({ status: 401 });
	});

	it("rejects a token that never expires", async () => {
		opaque.set("gl-forever", { app: CLIENT_ID, owner: 42, left: null });
		await expect(validateMachineToken("gl-forever")).rejects.toMatchObject({ status: 401 });
	});

	it("never asks token info at an IdP that is not Doorkeeper", async () => {
		doorkeeper = false;
		opaque.set("gl-opaque-2", { app: CLIENT_ID, owner: 42, left: 7200 });
		await expect(validateMachineToken("gl-opaque-2")).rejects.toThrow(/not a valid JWT/);
		expect(tokenInfoCalls).toBe(0);
	});
});

describe("authenticateMachineRequest", () => {
	it("maps a valid token's sub to the matching Cerea user", async () => {
		const { user } = await createTestUser();
		const token = await signToken({ sub: user.hfUserId });
		const result = await authenticateMachineRequest({
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": "machine-1",
			"x-pystino-machine-name": "test box",
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.principal.userId.toString()).toBe(user._id.toString());
			expect(result.principal.machineId).toBe("machine-1");
			expect(result.principal.machineName).toBe("test box");
		}
	});

	it("answers 403 for a token naming nobody this deployment knows", async () => {
		const token = await signToken({ sub: "hf-nobody" });
		const result = await authenticateMachineRequest({
			authorization: `Bearer ${token}`,
			"x-pystino-machine-id": "machine-1",
		});
		expect(result).toEqual(expect.objectContaining({ ok: false, status: 403 }));
	});

	it("answers 401 with no Authorization header", async () => {
		const result = await authenticateMachineRequest({ "x-pystino-machine-id": "machine-1" });
		expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
	});

	it("answers 401 with no X-Pystino-Machine-Id header", async () => {
		const token = await signToken({ sub: "hf-user-1" });
		const result = await authenticateMachineRequest({ authorization: `Bearer ${token}` });
		expect(result).toEqual(expect.objectContaining({ ok: false, status: 401 }));
	});
});
