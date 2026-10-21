import { createECDH } from "node:crypto";
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

const overrides: Record<string, string> = {};

/** Change one VAPID setting while `withVapid` is in force ("" is unset). */
export function setVapid(key: "PUBLIC_KEY" | "PRIVATE_KEY" | "SUBJECT", value: string): void {
	overrides[`CHAT_VAPID_${key}`] = value;
}

/**
 * Switch push on for a test with a fresh key pair; returns the function that
 * puts the config back. The config manager refuses writes outside the
 * database-backed mode, so reads are intercepted instead.
 */
export function withVapid(subject = "mailto:ops@example.org"): () => void {
	const keys = generateVapidKeys(subject);
	setVapid("PUBLIC_KEY", keys.publicKey);
	setVapid("PRIVATE_KEY", keys.privateKey);
	setVapid("SUBJECT", keys.subject);
	const original = config.get.bind(config);
	const spy = vi
		.spyOn(config, "get")
		.mockImplementation((key) => overrides[key as string] ?? original(key));
	return () => {
		spy.mockRestore();
		for (const k of Object.keys(overrides)) delete overrides[k];
	};
}

/** An element a test knows is there; throws with a clear message when it is not. */
export function must<T>(value: T | null | undefined, what = "value"): T {
	if (value === null || value === undefined) throw new Error(`expected ${what} to be present`);
	return value;
}
