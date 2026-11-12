/**
 * Signed approval grants (ADR 0116 §4, defence in depth).
 *
 * A grant is `{index, id, digest, exp, sig}`: the approval's id, the digest of the exact action
 * (`actionDigest`), the time it stops being valid, and `sig = HMAC-SHA256(deviceBrowserKey,
 * id|digest|exp)` in lowercase hex. The runtime holds the device's key (it fetches it over the
 * authenticated link, `browser.key`, PROTOCOL.md section 10.7), so a grant can only have been
 * made by this Cerea for this machine. Site-rule grants (`site:<host>`) are signed too.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { open as unseal, seal } from "$lib/server/mcp/secretBox";
import type { ApprovalGrant } from "./contract";

/** How long a grant stays valid after the approval. */
export const GRANT_TTL_MS = 10 * 60_000;

export function signGrant(key: Buffer, grant: { id: string; digest: string; exp: number }): string {
	return createHmac("sha256", key).update(`${grant.id}|${grant.digest}|${grant.exp}`).digest("hex");
}

export function makeGrant(
	key: Buffer,
	input: { index: number; id: string; digest: string },
	now = Date.now()
): ApprovalGrant {
	const exp = now + GRANT_TTL_MS;
	return { ...input, exp, sig: signGrant(key, { id: input.id, digest: input.digest, exp }) };
}

/** What a runtime does with a grant; here for the fake runtime and the tests. */
export function verifyGrant(
	key: Buffer,
	grant: ApprovalGrant,
	now = Date.now()
): "ok" | "bad" | "expired" {
	const expected = Buffer.from(signGrant(key, grant), "hex");
	const given = Buffer.from(grant.sig, "hex");
	if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "bad";
	return now > grant.exp ? "expired" : "ok";
}

/**
 * The device's browser key: 32 random bytes Cerea generates the first time it is needed and keeps
 * sealed on the device row. Only the owner's device row is ever read (`userId` matches).
 */
export async function deviceBrowserKey(deviceId: string, userId: ObjectId): Promise<Buffer> {
	const _id = new ObjectId(deviceId);
	const device = await collections.codeDevices.findOne({ _id, userId });
	if (!device) throw new Error("No such machine.");
	if (device.browserKeySealed) return Buffer.from(unseal(device.browserKeySealed), "base64");
	const key = randomBytes(32);
	// Set only if still absent, so two first uses agree on one key.
	await collections.codeDevices.updateOne(
		{ _id, userId, browserKeySealed: { $exists: false } },
		{ $set: { browserKeySealed: seal(key.toString("base64")) } }
	);
	const after = await collections.codeDevices.findOne({ _id, userId });
	if (!after?.browserKeySealed) throw new Error("The browser key could not be stored.");
	return Buffer.from(unseal(after.browserKeySealed), "base64");
}
