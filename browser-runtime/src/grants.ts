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
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ApprovalGrant } from "./contract.ts";

export type GrantCheck =
	| "ok"
	| "no_key"
	| "bad_signature"
	| "expired"
	| "exp_too_far"
	| "digest_mismatch";

/** Cerea's grants live 10 minutes; one that claims much longer means the two clocks disagree. */
export const MAX_GRANT_LIFETIME_MS = 15 * 60_000;

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
	if (grant.exp > now + MAX_GRANT_LIFETIME_MS) return "exp_too_far";
	if (grant.exp <= now) return "expired";
	if (grant.digest !== digest) return "digest_mismatch";
	return "ok";
}

/**
 * The ids of user approvals already spent, each kept until its own expiry (after which the
 * signature check refuses it anyway) and written to a file, so a restart does not forget them.
 */
export class UsedGrants {
	private readonly ids = new Map<string, number>();
	private readonly file?: string;

	constructor(file?: string, now = Date.now()) {
		this.file = file;
		if (!file) return;
		try {
			const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			for (const [id, exp] of Object.entries(saved)) {
				if (typeof exp === "number" && exp > now) this.ids.set(id, exp);
			}
		} catch {
			// No file yet, or unreadable: nothing was spent that we know of.
		}
	}

	has(id: string, now = Date.now()): boolean {
		const exp = this.ids.get(id);
		return exp !== undefined && exp > now;
	}

	/** Marks the id spent until `exp`. Throws if it cannot be written: nothing should then run. */
	add(id: string, exp: number, now = Date.now()): void {
		for (const [other, until] of this.ids) if (until <= now) this.ids.delete(other);
		this.ids.set(id, exp);
		if (!this.file) return;
		mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
		const tmp = `${this.file}.${process.pid}.tmp`;
		writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.ids)), { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.file);
	}
}
