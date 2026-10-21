import { decryptPayload, must } from "./testSupport";
import { createECDH, createPublicKey, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	b64urlDecode,
	b64urlEncode,
	derivePublicKey,
	generateVapidKeys,
	sendWebPush,
} from "./webpush";

/** RFC 8291 appendix A: the worked example, byte for byte. */
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
	uaPublic:
		"BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
	auth: "BTBZMqHH6r4Tts7J_aSIgg",
	salt: "DGv6ra1nlYgDCS1FRnbzlw",
	body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

function browser() {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => i * 7));
	return {
		ecdh,
		auth,
		target: { p256dh: b64urlEncode(ecdh.getPublicKey()), auth: b64urlEncode(auth) },
	};
}

describe("request encryption (web-push, checked against RFC 8291)", () => {
	it("the receiving side here decrypts the RFC 8291 example", () => {
		const receiver = createECDH("prime256v1");
		receiver.setPrivateKey(b64urlDecode(RFC.uaPrivate));
		expect(b64urlEncode(receiver.getPublicKey())).toBe(RFC.uaPublic);
		expect(
			decryptPayload(b64urlDecode(RFC.body), receiver, b64urlDecode(RFC.auth)).toString()
		).toBe(RFC.plaintext);
	});

	it("a generated request decrypts for the browser that holds the private key", async () => {
		const b = browser();
		const message = JSON.stringify({ title: "héllo", body: "ünïcode ✓" });
		const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
		await sendWebPush(
			{ endpoint: "https://push.example.net/s/t", ...b.target },
			message,
			generateVapidKeys(),
			{ ttl: 60, urgency: "normal" },
			fetchImpl
		);
		const [, init] = must(fetchImpl.mock.calls[0]);
		expect(decryptPayload(Buffer.from(init.body), b.ecdh, b.auth).toString("utf8")).toBe(message);
	});

	it("uses a fresh salt and key for every message", async () => {
		const b = browser();
		const bodies: Buffer[] = [];
		const fetchImpl = vi.fn().mockImplementation(async (_u: string, init: RequestInit) => {
			bodies.push(Buffer.from(init.body as Uint8Array));
			return new Response(null, { status: 201 });
		});
		const t = { endpoint: "https://push.example.net/s/t", ...b.target };
		for (let i = 0; i < 2; i++)
			await sendWebPush(t, "x", generateVapidKeys(), { ttl: 1, urgency: "low" }, fetchImpl);
		expect(must(bodies[0]).equals(must(bodies[1]))).toBe(false);
	});

	it("refuses a payload that does not fit one record, and malformed keys", async () => {
		const b = browser();
		const t = { endpoint: "https://push.example.net/s/t", ...b.target };
		const o = { ttl: 1, urgency: "low" as const };
		const f = vi.fn();
		await expect(sendWebPush(t, "x".repeat(4096), generateVapidKeys(), o, f)).rejects.toThrow();
		await expect(
			sendWebPush({ ...t, auth: "AAAA" }, "x", generateVapidKeys(), o, f)
		).rejects.toThrow();
		await expect(
			sendWebPush({ ...t, p256dh: "AAAA" }, "x", generateVapidKeys(), o, f)
		).rejects.toThrow();
		expect(f).not.toHaveBeenCalled();
	});
});

describe("VAPID authorization (web-push)", () => {
	it("is an ES256 JWT for the endpoint's origin that the public key verifies", async () => {
		const keys = generateVapidKeys("mailto:ops@example.org");
		const b = browser();
		const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
		await sendWebPush(
			{ endpoint: "https://push.example.net/send/abc123?x=1", ...b.target },
			"x",
			keys,
			{ ttl: 1, urgency: "low" },
			fetchImpl
		);
		const header = must(fetchImpl.mock.calls[0])[1].headers.Authorization as string;
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, h, c, sig, k] = must(match);
		expect(k).toBe(keys.publicKey);
		expect(JSON.parse(b64urlDecode(h).toString())).toMatchObject({ alg: "ES256" });
		const claims = JSON.parse(b64urlDecode(c).toString());
		expect(claims).toMatchObject({
			aud: "https://push.example.net",
			sub: "mailto:ops@example.org",
		});
		expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
		const point = b64urlDecode(keys.publicKey);
		const publicKey = createPublicKey({
			format: "jwk",
			key: {
				kty: "EC",
				crv: "P-256",
				x: b64urlEncode(point.subarray(1, 33)),
				y: b64urlEncode(point.subarray(33)),
			},
		});
		const ok = createVerify("SHA256")
			.update(`${h}.${c}`)
			.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, b64urlDecode(sig));
		expect(ok).toBe(true);
	});

	it("always mints a 32-byte private key (node drops a leading zero byte)", () => {
		// About one key in 256 starts with 0x00: 3000 draws make a regression certain to show.
		for (let i = 0; i < 3000; i++) {
			expect(b64urlDecode(generateVapidKeys().privateKey).length).toBe(32);
		}
	});

	it("derives the public key from the private one", () => {
		const keys = generateVapidKeys();
		expect(derivePublicKey(keys.privateKey)).toBe(keys.publicKey);
	});
});

describe("sendWebPush", () => {
	const keys = generateVapidKeys();
	const b = browser();
	const target = { endpoint: "https://push.example.net/s/token", ...b.target };
	const options = { ttl: 3600, urgency: "high" as const, topic: "ask-1" };
	const reply = (status: number, headers: Record<string, string> = {}) =>
		vi.fn().mockResolvedValue(new Response(null, { status, headers }));

	it("posts an encrypted body with TTL, urgency, topic and the VAPID header", async () => {
		const fetchImpl = reply(201);
		const outcome = await sendWebPush(target, '{"a":1}', keys, options, fetchImpl);
		expect(outcome).toEqual({ kind: "accepted", status: 201 });
		const [url, init] = must(fetchImpl.mock.calls[0]);
		expect(url).toBe(target.endpoint);
		expect(init.method).toBe("POST");
		expect(init.headers).toMatchObject({
			"Content-Encoding": "aes128gcm",
			TTL: "3600",
			Urgency: "high",
			Topic: "ask-1",
		});
		expect(init.headers.Authorization).toMatch(/^vapid t=.+, k=.+$/);
		expect(decryptPayload(Buffer.from(init.body), b.ecdh, b.auth).toString()).toBe('{"a":1}');
	});

	it.each([404, 410])("reports %i as gone", async (status) => {
		expect(await sendWebPush(target, "{}", keys, options, reply(status))).toEqual({
			kind: "gone",
			status,
		});
	});

	it("reports 429 with Retry-After and 5xx as retryable", async () => {
		expect(
			await sendWebPush(target, "{}", keys, options, reply(429, { "retry-after": "30" }))
		).toEqual({ kind: "retry", status: 429, retryAfterSeconds: 30 });
		expect(await sendWebPush(target, "{}", keys, options, reply(503))).toEqual({
			kind: "retry",
			status: 503,
		});
	});

	it("reports other 4xx as rejected and a network failure as retry", async () => {
		expect(await sendWebPush(target, "{}", keys, options, reply(403))).toEqual({
			kind: "rejected",
			status: 403,
		});
		const down = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
		expect(await sendWebPush(target, "{}", keys, options, down)).toEqual({
			kind: "retry",
			status: 0,
		});
	});
});
