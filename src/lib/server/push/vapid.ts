import { config } from "$lib/server/config";
import { logger } from "$lib/server/logger";
import { b64urlDecode, derivePublicKey, type VapidKeys } from "./webpush";

let warnedFor = "";

/**
 * The deployment's Web Push identity, or null when push is off.
 *
 * Off means unset, and also means wrong: a public key that is not the
 * private key's would make the push service refuse every message, so the
 * feature is withheld (and said so once in the log) instead of offering a
 * switch that cannot work. Read from the environment each call, so a test or
 * a hot reload sees a change; the checks are a few microseconds.
 */
export function vapidKeys(): VapidKeys | null {
	const publicKey = (config.CHAT_VAPID_PUBLIC_KEY ?? "").trim();
	const privateKey = (config.CHAT_VAPID_PRIVATE_KEY ?? "").trim();
	const subject = (config.CHAT_VAPID_SUBJECT ?? "").trim();
	if (!publicKey || !privateKey) return null;

	const problem = keyProblem(publicKey, privateKey, subject);
	if (problem) {
		const fingerprint = `${publicKey}|${problem}`;
		if (warnedFor !== fingerprint) {
			warnedFor = fingerprint;
			logger.warn({ problem }, "push notifications are off: the VAPID configuration is unusable");
		}
		return null;
	}
	return { publicKey, privateKey, subject };
}

function keyProblem(publicKey: string, privateKey: string, subject: string): string | null {
	try {
		if (b64urlDecode(privateKey).length !== 32) return "the private key is not 32 bytes";
		if (b64urlDecode(publicKey).length !== 65) return "the public key is not 65 bytes";
		if (derivePublicKey(privateKey) !== publicKey) return "the keys are not a pair";
	} catch {
		return "the keys are not valid base64url P-256 keys";
	}
	if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/.test(subject)) {
		return "CHAT_VAPID_SUBJECT must be a mailto: or https: address";
	}
	return null;
}

/** What the browser needs to subscribe, or null when push is off. */
export function pushPublicKey(): string | null {
	return vapidKeys()?.publicKey ?? null;
}
