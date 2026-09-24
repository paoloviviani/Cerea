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
import { gatewaySessionCheck } from "../gatewaySession";

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
		const good = await gatewaySessionCheck("contract-good", key, {
			baseUrl: base,
			userToken: true,
		});
		expect(good?.valid).toBe(true);
		const bad = await gatewaySessionCheck("contract-bad", "gwk_not_a_key", {
			baseUrl: base,
			userToken: true,
		});
		expect(bad).toEqual({ valid: false });
	});

	it("GET /v1/models answers without a credential, OpenAI-shaped (ADR 0081)", async () => {
		const response = await fetch(`${base}/models`);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { data?: { id?: unknown }[] };
		expect(Array.isArray(body.data)).toBe(true);
		for (const model of body.data ?? []) expect(typeof model.id).toBe("string");
	});
});
