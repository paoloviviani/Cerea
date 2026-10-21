import { createDecipheriv, createECDH, hkdfSync, type ECDH } from "node:crypto";
import { vi } from "vitest";
import { b64urlEncode, generateVapidKeys } from "./webpush";
import { config } from "$lib/server/config";

/** A subscription as a browser would hand it over, with the keys to decrypt it. */
export function fakeBrowser(endpoint = `https://push.example.net/send/${crypto.randomUUID()}`) {
	const ecdh = createECDH("prime256v1");
	ecdh.generateKeys();
	const auth = Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)));
	return {
		ecdh,
		auth,
		subscription: {
			endpoint,
			p256dh: b64urlEncode(ecdh.getPublicKey()),
			auth: b64urlEncode(auth),
			userAgent: "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36",
		},
	};
}

let current: Record<string, string> | null = null;

/** Change one VAPID setting while `withVapid` is in force ("" is unset). */
export function setVapid(key: "PUBLIC_KEY" | "PRIVATE_KEY" | "SUBJECT", value: string): void {
	if (!current) throw new Error("setVapid needs withVapid first");
	current[`CHAT_VAPID_${key}`] = value;
}

/**
 * Switch push on for a test with a fresh key pair; returns the function that
 * puts the config back. The config manager refuses writes outside the
 * database-backed mode, so reads are intercepted instead. The overrides belong
 * to this call, so nothing a test sets can outlive its own restore.
 */
export function withVapid(subject = "mailto:ops@example.org"): () => void {
	const keys = generateVapidKeys(subject);
	const mine: Record<string, string> = {};
	current = mine;
	setVapid("PUBLIC_KEY", keys.publicKey);
	setVapid("PRIVATE_KEY", keys.privateKey);
	setVapid("SUBJECT", keys.subject);
	const original = config.get.bind(config);
	const spy = vi
		.spyOn(config, "get")
		.mockImplementation((key) => mine[key as string] ?? original(key));
	return () => {
		spy.mockRestore();
		if (current === mine) current = null;
	};
}

function hkdf(ikm: Buffer, salt: Buffer, info: Buffer, length: number): Buffer {
	return Buffer.from(hkdfSync("sha256", ikm, salt, info, length));
}

/** RFC 8291 decryption, the receiving side: proves a request's bytes are right. */
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

/** An element a test knows is there; throws with a clear message when it is not. */
export function must<T>(value: T | null | undefined, what = "value"): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}
