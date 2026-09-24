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
			res.end(JSON.stringify({ issuer: advertisedIssuer, jwks_uri: `${ISSUER_URL}/jwks` }));
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
