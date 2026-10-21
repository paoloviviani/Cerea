import { must } from "./testSupport";
import { createECDH, createPublicKey, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	b64urlDecode,
	b64urlEncode,
	decryptPayload,
	derivePublicKey,
	encryptPayload,
	generateVapidKeys,
	sendWebPush,
	vapidAuthorization,
} from "./webpush";

/** RFC 8291 appendix A: the worked example, byte for byte. */
const RFC = {
	plaintext: "When I grow up, I want to be a watermelon",
	asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
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

describe("encryptPayload", () => {
	it("reproduces the RFC 8291 example exactly", () => {
		const sender = createECDH("prime256v1");
		sender.setPrivateKey(b64urlDecode(RFC.asPrivate));
		const body = encryptPayload(
			Buffer.from(RFC.plaintext),
			{ p256dh: RFC.uaPublic, auth: RFC.auth },
			{ salt: b64urlDecode(RFC.salt), sender }
		);
		expect(b64urlEncode(body)).toBe(RFC.body);
	});

	it("round-trips for a browser that holds the private key", () => {
		const b = browser();
		const message = JSON.stringify({ title: "héllo", body: "ünïcode ✓" });
		const body = encryptPayload(Buffer.from(message), b.target);
		expect(decryptPayload(body, b.ecdh, b.auth).toString("utf8")).toBe(message);
	});

	it("uses a fresh salt and key for every message", () => {
		const b = browser();
		const a = encryptPayload(Buffer.from("x"), b.target);
		const c = encryptPayload(Buffer.from("x"), b.target);
		expect(a.equals(c)).toBe(false);
	});

	it("refuses a payload that does not fit one record, and malformed keys", () => {
		const b = browser();
		expect(() => encryptPayload(Buffer.alloc(4096), b.target)).toThrow(/too large/);
		expect(() => encryptPayload(Buffer.from("x"), { ...b.target, auth: "AAAA" })).toThrow(/auth/);
		expect(() => encryptPayload(Buffer.from("x"), { ...b.target, p256dh: "AAAA" })).toThrow(
			/p256dh/
		);
	});
});

describe("vapidAuthorization", () => {
	it("is an ES256 JWT for the endpoint's origin that the public key verifies", () => {
		const keys = generateVapidKeys("mailto:ops@example.org");
		const now = 1_800_000_000_000;
		const header = vapidAuthorization("https://push.example.net/send/abc123?x=1", keys, now);
		const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
		expect(match).not.toBeNull();
		const [, h, c, sig, k] = must(match);
		expect(k).toBe(keys.publicKey);
		expect(JSON.parse(b64urlDecode(h).toString())).toEqual({ typ: "JWT", alg: "ES256" });
		expect(JSON.parse(b64urlDecode(c).toString())).toEqual({
			aud: "https://push.example.net",
			exp: 1_800_000_000 + 12 * 3600,
			sub: "mailto:ops@example.org",
		});
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
