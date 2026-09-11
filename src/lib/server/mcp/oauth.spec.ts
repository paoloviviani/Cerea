/**
 * The two parts of connector OAuth that fail dangerously rather than loudly
 * (ADR 0064).
 *
 * Sealing, because a bug there stores a plaintext token or silently accepts a
 * tampered one. And the state/session binding, because a callback that does
 * not check it is a way to attach an attacker's authorisation to somebody
 * else's account — which looks exactly like a working feature from the
 * outside, and is the reason this file exists rather than a note in the ADR.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";

beforeAll(async () => {
	await ready;
}, 30000);

describe("sealing a credential", () => {
	it("round-trips a token", async () => {
		const { seal, open } = await import("./secretBox");
		const token = "ntn_a-real-looking-notion-token-0123456789";
		const sealed = seal(token);
		expect(sealed).not.toContain(token);
		expect(open(sealed)).toBe(token);
	});

	it("produces a different ciphertext each time", async () => {
		// A fresh IV per call. Equal ciphertexts would leak that two people
		// hold the same token, which is exactly what happens when somebody
		// "optimises" the IV to a constant.
		const { seal } = await import("./secretBox");
		expect(seal("same")).not.toBe(seal("same"));
	});

	it("refuses a tampered ciphertext rather than returning something", async () => {
		// GCM authenticates, and this is the test that proves we are checking
		// the tag rather than just decrypting.
		const { seal, open } = await import("./secretBox");
		const sealed = seal("secret");
		const parts = sealed.split(":");
		const flipped = Buffer.from(parts[3], "base64url");
		flipped[0] ^= 0xff;
		parts[3] = flipped.toString("base64url");
		expect(() => open(parts.join(":"))).toThrow();
	});

	it("refuses a value from another scheme", async () => {
		const { open } = await import("./secretBox");
		expect(() => open("not-sealed-at-all")).toThrow(/version|sealed/i);
	});
});

describe("completing an authorization", () => {
	beforeEach(async () => {
		await collections.mcpOauthPending.deleteMany({});
		await collections.mcpConnectors.deleteMany({});
		await collections.mcpTokens.deleteMany({});
	}, 20000);

	async function pending(overrides: Record<string, unknown> = {}) {
		const row = {
			_id: new ObjectId(),
			state: "a-state-we-issued",
			connectorId: new ObjectId(),
			userId: new ObjectId(),
			sessionId: "the-session-that-started-it",
			verifier: "a-verifier",
			next: "/chat/",
			createdAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
			...overrides,
		};
		await collections.mcpOauthPending.insertOne(row as never);
		return row;
	}

	it("refuses a code arriving in a different session", async () => {
		// The bug this exists for. Without the check, an attacker completes a
		// flow they started and the tokens land on whoever's browser followed
		// the link — their account, the victim's connector.
		const { completeAuthorization } = await import("./oauth");
		await pending();

		await expect(
			completeAuthorization({
				state: "a-state-we-issued",
				code: "whatever",
				sessionId: "somebody-else's-session",
			})
		).rejects.toThrow(/different session/i);
	});

	it("consumes the state, so a replayed code finds nothing", async () => {
		const { completeAuthorization } = await import("./oauth");
		await pending();

		// The first attempt fails for a later reason — there is no connector —
		// but it must still have consumed the state.
		await expect(
			completeAuthorization({
				state: "a-state-we-issued",
				code: "c",
				sessionId: "the-session-that-started-it",
			})
		).rejects.toThrow();

		expect(await collections.mcpOauthPending.findOne({ state: "a-state-we-issued" })).toBeNull();

		await expect(
			completeAuthorization({
				state: "a-state-we-issued",
				code: "c",
				sessionId: "the-session-that-started-it",
			})
		).rejects.toThrow(/expired or was already completed/i);
	});

	it("refuses an unknown state", async () => {
		const { completeAuthorization } = await import("./oauth");
		await expect(
			completeAuthorization({ state: "never-issued", code: "c", sessionId: "s" })
		).rejects.toThrow(/expired or was already completed/i);
	});

	it("refuses a state that has expired", async () => {
		const { completeAuthorization } = await import("./oauth");
		await pending({ state: "stale", expiresAt: new Date(Date.now() - 1000) });

		await expect(
			completeAuthorization({
				state: "stale",
				code: "c",
				sessionId: "the-session-that-started-it",
			})
		).rejects.toThrow(/expired/i);
	});
});

describe("the bearer token for a call", () => {
	beforeEach(async () => {
		await collections.mcpConnectors.deleteMany({});
		await collections.mcpTokens.deleteMany({});
	}, 20000);

	it("is null for a connector this person has not authorised", async () => {
		const { bearerFor } = await import("./oauth");
		const connector = {
			_id: new ObjectId(),
			userId: new ObjectId(),
			name: "n",
			url: "https://example.org/mcp",
			auth: "oauth" as const,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		expect(await bearerFor({ connector, userId: new ObjectId() })).toBeNull();
	});

	it("is the static token for a token connector, unsealed", async () => {
		const { seal } = await import("./secretBox");
		const { bearerFor } = await import("./oauth");
		const connector = {
			_id: new ObjectId(),
			userId: new ObjectId(),
			name: "n",
			url: "https://example.org/mcp",
			auth: "token" as const,
			tokenSealed: seal("a-static-token"),
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		expect(await bearerFor({ connector, userId: new ObjectId() })).toBe("a-static-token");
	});

	it("drops a token it cannot refresh rather than keeping a dead one", async () => {
		// An expired access token with no refresh token is unusable. Keeping
		// the row would make every later call fail identically with no prompt
		// to sign in again.
		const { seal } = await import("./secretBox");
		const { bearerFor } = await import("./oauth");
		const connectorId = new ObjectId();
		const userId = new ObjectId();
		const connector = {
			_id: connectorId,
			userId,
			name: "n",
			url: "https://example.org/mcp",
			auth: "oauth" as const,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId,
			userId,
			accessTokenSealed: seal("expired"),
			expiresAt: new Date(Date.now() - 60_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		expect(await bearerFor({ connector, userId })).toBeNull();
		expect(await collections.mcpTokens.findOne({ connectorId, userId })).toBeNull();
	});

	it("returns a live token without touching the network", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { seal } = await import("./secretBox");
		const { bearerFor } = await import("./oauth");
		const connectorId = new ObjectId();
		const userId = new ObjectId();
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId,
			userId,
			accessTokenSealed: seal("still-good"),
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		const token = await bearerFor({
			connector: {
				_id: connectorId,
				userId,
				name: "n",
				url: "https://example.org/mcp",
				auth: "oauth",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			userId,
		});
		expect(token).toBe("still-good");
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});
