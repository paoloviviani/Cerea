/**
 * The gateway contract: what this chat assumes about Pystino's API, checked
 * against a real gateway (ADR 0087 — two repositories, kept in lockstep by
 * tests rather than by memory).
 *
 * Skipped unless GATEWAY_CONTRACT_URL (…/v1) and GATEWAY_CONTRACT_KEY (a gwk_
 * key) are set: the contract workflow starts a gateway at the version the
 * chat pins, seeds a key, and runs this. Each assertion is a shape a module
 * here parses — if the gateway changes it, this fails before a deployment does.
 */
import { describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { gatewaySessionCheck } from "../gatewaySession";
import { collections, ready } from "../database";

const base = process.env.GATEWAY_CONTRACT_URL ?? "";
const key = process.env.GATEWAY_CONTRACT_KEY ?? "";

describe.skipIf(!base || !key)("gateway contract", () => {
	it("GET /v1/me carries what admin.ts and gatewaySession.ts read", async () => {
		const response = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${key}` } });
		expect(response.status).toBe(200);
		const body = (await response.json()) as Record<string, unknown>;
		expect(typeof body.id).toBe("string");
		expect(typeof body.is_admin).toBe("boolean");
		expect(typeof body.credential).toBe("string");
		expect(Array.isArray(body.groups)).toBe(true);
		expect("email" in body && "display_name" in body && "default_billing_group" in body).toBe(true);
	});

	it("a credential the gateway accepts keeps the session; a bad one ends it", async () => {
		// ADR 0093 §4.4: the check now reads the chat's own session and user
		// (createdAt, gatewayUserId), so a good credential needs a seeded row
		// naming the same gateway id this key resolves to — a bare sessionId
		// with nothing behind it is indistinguishable from one that ended.
		await ready;
		const meResponse = await fetch(`${base}/me`, { headers: { authorization: `Bearer ${key}` } });
		const me = (await meResponse.json()) as { id: string };
		const userId = new ObjectId();
		await collections.users.insertOne({
			_id: userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			name: "contract",
			hfUserId: "contract",
			gatewayUserId: me.id,
		} as never);
		const sessionId = "contract-good";
		await collections.sessions.insertOne({
			_id: new ObjectId(),
			sessionId,
			userId,
			createdAt: new Date(),
			updatedAt: new Date(),
			expiresAt: new Date(Date.now() + 60_000),
		} as never);

		try {
			const good = await gatewaySessionCheck(sessionId, key, {
				baseUrl: base,
				userToken: true,
			});
			expect(good?.kind).toBe("valid");
			const bad = await gatewaySessionCheck("contract-bad", "gwk_not_a_key", {
				baseUrl: base,
				userToken: true,
			});
			expect(bad).toEqual({ kind: "ended" });
		} finally {
			await collections.users.deleteOne({ _id: userId });
			await collections.sessions.deleteOne({ sessionId });
		}
	});

	it("GET /v1/models answers without a credential, OpenAI-shaped (ADR 0081)", async () => {
		const response = await fetch(`${base}/models`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data?: { id?: unknown }[] };
		expect(Array.isArray(body.data)).toBe(true);
		for (const model of body.data ?? []) expect(typeof model.id).toBe("string");
	});
});
