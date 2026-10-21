/**
 * Web Push, on `node:crypto` alone: the VAPID identity (RFC 8292) and the
 * aes128gcm payload encryption (RFC 8188 as profiled by RFC 8291).
 *
 * Why not the `web-push` package: it is MPL-2.0 and pulls six more packages
 * for what is about a hundred lines here (one HKDF chain, one AES-GCM
 * record, one ES256 token), and a sender that talks to addresses people hand
 * us is better with the repo's own SSRF-guarded fetch than with the
 * package's `https` agent. The encryption is pinned against the worked
 * example in RFC 8291 appendix A (`webpush.spec.ts`).
 *
 * Nothing here knows about people, settings or events: it turns "this
 * subscription, this text" into one HTTP request and says what came back.
 */

import {
	createCipheriv,
	createDecipheriv,
	createECDH,
	createPrivateKey,
	createSign,
	hkdfSync,
	randomBytes,
	type ECDH,
} from "node:crypto";

export interface PushTarget {
	endpoint: string;
	/** The browser's public key, base64url (65 bytes uncompressed). */
	p256dh: string;
	/** The browser's shared secret, base64url (16 bytes). */
	auth: string;
}

export interface VapidKeys {
	/** The 65-byte public point, base64url: what the browser subscribes with. */
	publicKey: string;
	/** The 32-byte private scalar, base64url. */
	privateKey: string;
	/** `mailto:` or `https:` contact for the push service to reach the operator. */
	subject: string;
}

export function b64urlEncode(buf: Uint8Array): string {
	return Buffer.from(buf).toString("base64url");
}

export function b64urlDecode(text: string): Buffer {
	return Buffer.from(text, "base64url");
}

/** The public point of a P-256 private scalar. */
export function derivePublicKey(privateKey: string): string {
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(b64urlDecode(privateKey));
	return b64urlEncode(ecdh.getPublicKey());
}

/** A fresh VAPID pair (what `./configure` mints in the kit; used by tests). */
export function generateVapidKeys(subject = "mailto:ops@example.org"): VapidKeys {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	return {
		publicKey: b64urlEncode(ecdh.getPublicKey()),
		privateKey: b64urlEncode(ecdh.getPrivateKey()),
		subject,
	};
}

/** Largest plaintext one record holds: 4096 - 16 (tag) - 1 (delimiter). */
export const MAX_PLAINTEXT_BYTES = 4096 - 17;

const RECORD_SIZE = 4096;

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
	return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/**
 * RFC 8291 §3: one aes128gcm record. `salt` and `sender` exist so the RFC's
 * test vector can be reproduced; production passes neither.
 */
export function encryptPayload(
	plaintext: Buffer,
	target: Pick<PushTarget, "p256dh" | "auth">,
	options: { salt?: Buffer; sender?: ECDH } = {}
): Buffer {
	if (plaintext.length > MAX_PLAINTEXT_BYTES) throw new Error("push payload too large");
	const uaPublic = b64urlDecode(target.p256dh);
	const authSecret = b64urlDecode(target.auth);
	if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) throw new Error("invalid p256dh key");
	if (authSecret.length !== 16) throw new Error("invalid auth secret");

	const sender = options.sender ?? createECDH("prime256v1");
	if (!options.sender) sender.generateKeys();
	const asPublic = sender.getPublicKey();
	const salt = options.salt ?? randomBytes(16);

	const shared = sender.computeSecret(uaPublic);
	const prk = hkdf(
		shared,
		authSecret,
		Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
		32
	);
	const cek = hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12);

	// One and only record, so it carries the "last record" delimiter 0x02.
	const cipher = createCipheriv("aes-128-gcm", cek, nonce);
	const body = Buffer.concat([
		cipher.update(Buffer.concat([plaintext, Buffer.from([0x02])])),
		cipher.final(),
		cipher.getAuthTag(),
	]);

	const header = Buffer.alloc(16 + 4 + 1);
	salt.copy(header, 0);
	header.writeUInt32BE(RECORD_SIZE, 16);
	header.writeUInt8(asPublic.length, 20);
	return Buffer.concat([header, asPublic, body]);
}

/** The inverse, for tests and for a browser-side check of the format. */
export function decryptPayload(body: Buffer, receiver: ECDH, authSecret: Buffer): Buffer {
	const salt = body.subarray(0, 16);
	const idLen = body.readUInt8(20);
	const asPublic = body.subarray(21, 21 + idLen);
	const data = body.subarray(21 + idLen);
	const uaPublic = receiver.getPublicKey();
	const prk = hkdf(
		receiver.computeSecret(asPublic),
		authSecret,
		Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]),
		32
	);
	const cek = hkdf(prk, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
	const nonce = hkdf(prk, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
	const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
	decipher.setAuthTag(data.subarray(data.length - 16));
	const padded = Buffer.concat([
		decipher.update(data.subarray(0, data.length - 16)),
		decipher.final(),
	]);
	let end = padded.length;
	while (end > 0 && padded[end - 1] === 0) end--;
	return padded.subarray(0, end - 1); // drop the delimiter
}

/** RFC 8292: `vapid t=<jwt>, k=<public key>`, the token good for 12 hours. */
export function vapidAuthorization(
	endpoint: string,
	keys: VapidKeys,
	nowMs: number = Date.now()
): string {
	const audience = new URL(endpoint).origin;
	const claims = {
		aud: audience,
		exp: Math.floor(nowMs / 1000) + 12 * 3600,
		sub: keys.subject,
	};
	const signingInput = `${b64urlEncode(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${b64urlEncode(Buffer.from(JSON.stringify(claims)))}`;
	const publicPoint = b64urlDecode(keys.publicKey);
	const key = createPrivateKey({
		format: "jwk",
		key: {
			kty: "EC",
			crv: "P-256",
			d: keys.privateKey,
			x: b64urlEncode(publicPoint.subarray(1, 33)),
			y: b64urlEncode(publicPoint.subarray(33, 65)),
		},
	});
	const signature = createSign("SHA256")
		.update(signingInput)
		.sign({ key, dsaEncoding: "ieee-p1363" });
	return `vapid t=${signingInput}.${b64urlEncode(signature)}, k=${keys.publicKey}`;
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface SendOptions {
	/** Seconds the push service may hold the message for an offline browser. */
	ttl: number;
	urgency: PushUrgency;
	/** A later message with the same topic replaces an undelivered earlier one. */
	topic?: string;
}

export type SendOutcome =
	/** The push service accepted it (201). */
	| { kind: "accepted"; status: number }
	/** 404 / 410: the subscription no longer exists; forget it. */
	| { kind: "gone"; status: number }
	/** 429 / 5xx / a network failure: the subscription may be fine, try later. */
	| { kind: "retry"; status: number; retryAfterSeconds?: number }
	/** Anything else (a bad request, a rejected VAPID identity): not retryable. */
	| { kind: "rejected"; status: number };

export type PushFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Send one message. Never throws for a push-service answer; a network error
 * is reported as `retry` with status 0. */
export async function sendWebPush(
	target: PushTarget,
	payload: string,
	keys: VapidKeys,
	options: SendOptions,
	fetchImpl: PushFetch,
	nowMs: number = Date.now()
): Promise<SendOutcome> {
	const body = encryptPayload(Buffer.from(payload, "utf8"), target);
	const headers: Record<string, string> = {
		Authorization: vapidAuthorization(target.endpoint, keys, nowMs),
		"Content-Encoding": "aes128gcm",
		"Content-Type": "application/octet-stream",
		TTL: String(Math.max(0, Math.floor(options.ttl))),
		Urgency: options.urgency,
	};
	// Topic is limited to 32 URL-safe base64 characters (RFC 8030 §5.4).
	if (options.topic) headers.Topic = options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);

	let response: Response;
	try {
		response = await fetchImpl(target.endpoint, {
			method: "POST",
			headers,
			body: new Uint8Array(body),
			signal: AbortSignal.timeout(10_000),
		});
	} catch {
		return { kind: "retry", status: 0 };
	}
	// Nothing in the body matters and some services stream a long one.
	void response.body?.cancel().catch(() => undefined);

	const status = response.status;
	if (status >= 200 && status < 300) return { kind: "accepted", status };
	if (status === 404 || status === 410) return { kind: "gone", status };
	if (status === 429 || status >= 500) {
		const header = Number(response.headers.get("retry-after"));
		return {
			kind: "retry",
			status,
			...(Number.isFinite(header) && header > 0 ? { retryAfterSeconds: header } : {}),
		};
	}
	return { kind: "rejected", status };
}
