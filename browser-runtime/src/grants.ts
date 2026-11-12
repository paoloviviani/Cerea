/**
 * Signed approval grants (ADR 0116 §4, defence in depth). Cerea signs each grant it issues with
 * the device's browser key: `sig = HMAC-SHA256(key, id|digest|exp)`, hex. The runtime checks the
 * signature, the expiry and then the digest before it runs a commit-class action.
 *
 * The key reaches the runtime from galopin, by `--key-file` (a 0600 file) or the environment
 * (`CEREA_BROWSER_KEY`). It is read at each check, so a rotation takes effect at once, and it is
 * never logged or returned. With no key, nothing commit-class runs.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ApprovalGrant } from "./contract.ts";

export type GrantCheck = "ok" | "no_key" | "bad_signature" | "expired" | "digest_mismatch";

export interface KeySource {
	keyFile?: string;
	env?: NodeJS.ProcessEnv;
}

/** The key is 32 bytes, written as base64url (what `browser.key` returns), in a file or the environment. */
export function readKey(source: KeySource): Buffer | undefined {
	let text: string | undefined;
	if (source.keyFile) {
		try {
			text = readFileSync(source.keyFile, "utf8").trim();
		} catch {
			// Missing or unreadable: no key.
		}
	} else {
		text = (source.env ?? process.env).CEREA_BROWSER_KEY?.trim();
	}
	if (!text) return undefined;
	const key = Buffer.from(text, "base64url");
	return key.length >= 16 ? key : undefined;
}

export function signGrant(key: Buffer, id: string, digest: string, exp: number): string {
	return createHmac("sha256", key).update(`${id}|${digest}|${exp}`).digest("hex");
}

export function checkGrant(
	grant: ApprovalGrant,
	digest: string,
	key: Buffer | undefined,
	now = Date.now()
): GrantCheck {
	if (!key) return "no_key";
	const want = Buffer.from(signGrant(key, grant.id, grant.digest, grant.exp), "hex");
	const got = Buffer.from(grant.sig, "hex");
	if (want.length !== got.length || !timingSafeEqual(want, got)) return "bad_signature";
	if (grant.exp <= now) return "expired";
	if (grant.digest !== digest) return "digest_mismatch";
	return "ok";
}
