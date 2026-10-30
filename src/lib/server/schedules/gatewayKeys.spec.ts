import { describe, expect, it, vi } from "vitest";
import { mintKey, revokeKey } from "./gatewayKeys";
import { CredentialError } from "./executors";

const BASE = "https://gateway.test/v1";
const reply = (status: number, body?: unknown) =>
	vi.fn(async () => new Response(body === undefined ? null : JSON.stringify(body), { status }));

describe("mintKey", () => {
	it("posts the name and billing group as the person, and returns the id and the secret", async () => {
		const fetchImpl = reply(201, { id: "k1", secret: "sk-abc", name: "x" });
		const key = await mintKey(
			{ token: "session", name: "Cerea schedule: Weekly", billingGroupId: "g1" },
			{ baseUrl: BASE, fetchImpl }
		);

		expect(key).toEqual({ id: "k1", secret: "sk-abc" });
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${BASE}/me/keys`);
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).authorization).toBe("Bearer session");
		expect(JSON.parse(String(init.body))).toEqual({
			name: "Cerea schedule: Weekly",
			billing_group_id: "g1",
		});
	});

	it("asks for a key that expires, when told how long", async () => {
		const fetchImpl = reply(201, { id: "k1", secret: "s" });
		await mintKey({ token: "t", name: "n", expiresInDays: 180 }, { baseUrl: BASE, fetchImpl });
		expect(
			JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
		).toEqual({ name: "n", expires_in_days: 180 });
	});

	it("explains a refusal for want of API keys or a billing group, keeping the gateway's own text", async () => {
		const keys = await mintKey(
			{ token: "t", name: "n" },
			{ baseUrl: BASE, fetchImpl: reply(403, { error: { message: "No API keys for you." } }) }
		).catch((e) => e);
		expect(keys.message).toContain("may not create one");
		expect(keys.message).toContain("No API keys for you.");
		const billing = await mintKey(
			{ token: "t", name: "n" },
			{ baseUrl: BASE, fetchImpl: reply(400, { detail: "Set a default billing group." }) }
		).catch((e) => e);
		expect(billing.message).toContain("would not make the schedule's key");
		expect(billing.message).toContain("Set a default billing group.");
	});

	it("leaves the billing group out when there is none", async () => {
		const fetchImpl = reply(201, { id: "k1", secret: "s" });
		await mintKey({ token: "t", name: "n" }, { baseUrl: BASE, fetchImpl });
		expect(
			JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body))
		).toEqual({
			name: "n",
		});
	});

	it.each([
		[401, 403, /Sign in again/],
		[403, 403, /may not create one/],
		[400, 400, /billing group/],
		[500, 502, /could not make/],
	])("turns a %i into a readable %i", async (status, mapped, words) => {
		const body = { detail: "Set a default billing group, or name one for this key." };
		const fetchImpl = reply(
			status,
			status === 403 ? { detail: "This account may not use API keys." } : body
		);
		const error = await mintKey({ token: "t", name: "n" }, { baseUrl: BASE, fetchImpl }).catch(
			(e) => e
		);
		expect(error).toBeInstanceOf(CredentialError);
		expect(error.status).toBe(mapped);
		expect(error.message).toMatch(words);
	});

	it("says the gateway did not answer, rather than throwing a network error", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		});
		await expect(
			mintKey({ token: "t", name: "n" }, { baseUrl: BASE, fetchImpl })
		).rejects.toMatchObject({ status: 502 });
	});

	it("refuses an answer without a secret", async () => {
		await expect(
			mintKey({ token: "t", name: "n" }, { baseUrl: BASE, fetchImpl: reply(201, { id: "k" }) })
		).rejects.toMatchObject({ status: 502 });
	});

	it("is a clear refusal when there is no gateway", async () => {
		await expect(mintKey({ token: "t", name: "n" }, { baseUrl: "" })).rejects.toMatchObject({
			status: 400,
		});
	});
});

describe("revokeKey", () => {
	it("deletes the key by id and says it is gone", async () => {
		const fetchImpl = reply(200, {});
		expect(await revokeKey({ token: "t", keyId: "k 1" }, { baseUrl: BASE, fetchImpl })).toBe(true);
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe(`${BASE}/me/keys/k%201`);
		expect(init.method).toBe("DELETE");
	});

	it("counts a key that is already gone as revoked", async () => {
		expect(
			await revokeKey({ token: "t", keyId: "k" }, { baseUrl: BASE, fetchImpl: reply(404) })
		).toBe(true);
	});

	it("says false when the gateway cannot tell", async () => {
		expect(
			await revokeKey({ token: "t", keyId: "k" }, { baseUrl: BASE, fetchImpl: reply(500) })
		).toBe(false);
		const down = vi.fn(async () => {
			throw new Error("down");
		});
		expect(await revokeKey({ token: "t", keyId: "k" }, { baseUrl: BASE, fetchImpl: down })).toBe(
			false
		);
	});
});
