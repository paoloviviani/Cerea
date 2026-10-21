/**
 * Web Push: the VAPID identity (RFC 8292) and the aes128gcm payload encryption
 * (RFC 8291) are the `web-push` package's, used only to BUILD a request
 * (`generateRequestDetails`). Sending is ours: `push/guard.ts` refuses every
 * destination that is not a public https host, which the package's own sender
 * does not do for addresses people hand us. Its encryption is checked against
 * the RFC 8291 example in `webpush.spec.ts`.
 *
 * Nothing here knows about people, settings or events: it turns "this
 * subscription, this text" into one HTTP request and says what came back.
 */

import { createECDH } from "node:crypto";
import webpush from "web-push";

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
		// getPrivateKey() drops leading zero bytes (about one key in 256), which
		// would give a 31-byte "private key": left-pad to the scalar's 32.
		privateKey: b64urlEncode(
			Buffer.concat([Buffer.alloc(32 - ecdh.getPrivateKey().length), ecdh.getPrivateKey()])
		),
		subject,
	};
}

/** Largest plaintext one record holds: 4096 - 16 (tag) - 1 (delimiter). */
export const MAX_PLAINTEXT_BYTES = 4096 - 17;

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
	fetchImpl: PushFetch
): Promise<SendOutcome> {
	if (Buffer.byteLength(payload) > MAX_PLAINTEXT_BYTES) throw new Error("push payload too large");
	const request = webpush.generateRequestDetails(
		{ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
		payload,
		{
			vapidDetails: {
				subject: keys.subject,
				publicKey: keys.publicKey,
				privateKey: keys.privateKey,
			},
			TTL: Math.max(0, Math.floor(options.ttl)),
			urgency: options.urgency,
			...(options.topic
				? { topic: options.topic.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) }
				: {}),
			contentEncoding: "aes128gcm",
		}
	);
	// fetch sets Content-Length itself; the package hands TTL over as a number.
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(request.headers)) {
		if (name.toLowerCase() !== "content-length") headers[name] = String(value);
	}

	let response: Response;
	try {
		response = await fetchImpl(request.endpoint, {
			method: "POST",
			headers,
			body: new Uint8Array(request.body as Buffer),
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
