/**
 * Encrypting a connector's credential at rest.
 *
 * The credentials this holds are third-party OAuth tokens and static API
 * tokens for MCP connectors (ADR 0064). They used to live in browser
 * `localStorage`, where any XSS on the origin could read them; moving them to
 * the server is most of the fix, and encrypting them means a Mongo backup or a
 * stray `db.mcpConnectors.find()` does not hand somebody a working Notion
 * token.
 *
 * AES-256-GCM, which authenticates as well as encrypts: a tampered ciphertext
 * fails to open rather than decrypting to something attacker-chosen. The
 * stored form is `v1:<iv>:<tag>:<ciphertext>`, base64url each, with the version
 * first so a future scheme can be told apart without guessing.
 *
 * **The key comes from `CHAT_SECRET_KEY` and there is no default.** A default
 * would mean every deployment that forgot to set one shared a key, which is
 * indistinguishable from no encryption while looking like encryption. Absent,
 * this throws on first use — connectors stop working and nothing silently
 * stores a plaintext token.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
/** 96 bits, the size GCM is specified for and fastest with. */
const IV_BYTES = 12;

/**
 * The configured passphrase, or an empty string.
 *
 * From `process.env` and **not** through `$lib/server/config`, and that is a
 * decision rather than a shortcut: `config` proxies the environment *and the
 * `config` collection in Mongo*, so a key read through it could be set from
 * the database — which is the store this key protects. A credential-encryption
 * key the encrypted store can change protects nothing.
 */
function passphrase(): string {
	return process.env.CHAT_SECRET_KEY ?? "";
}

function key(): Buffer {
	const secret = passphrase();
	if (!secret || secret.trim().length === 0) {
		throw new Error(
			"CHAT_SECRET_KEY is not set, so connector credentials cannot be encrypted. " +
				"Set it to a long random string in the deployment's environment."
		);
	}
	// SHA-256 of the passphrase, so any length of secret yields a 32-byte key.
	// Not a KDF with a work factor on purpose: this is not a password being
	// guessed offline, it is a local secret, and a per-call scrypt would run on
	// every connector open.
	return createHash("sha256").update(secret, "utf-8").digest();
}

/** Encrypt a credential for storage. */
export function seal(plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv(ALGORITHM, key(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
	return [
		VERSION,
		iv.toString("base64url"),
		cipher.getAuthTag().toString("base64url"),
		ciphertext.toString("base64url"),
	].join(":");
}

/**
 * Open a stored credential.
 *
 * Throws on anything unexpected — a changed key, a truncated value, a
 * tampered ciphertext — rather than returning a partial result. The caller's
 * only sensible response is to treat the connector as unauthorised and ask the
 * person to sign in again, which is what a thrown error gets them.
 */
export function open(stored: string): string {
	const parts = stored.split(":");
	if (parts.length !== 4 || parts[0] !== VERSION) {
		throw new Error("not a sealed credential, or a version this build cannot read");
	}
	const [, iv, tag, ciphertext] = parts;
	const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, "base64url"));
	decipher.setAuthTag(Buffer.from(tag, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(ciphertext, "base64url")),
		decipher.final(),
	]).toString("utf-8");
}

/** Whether a credential can be stored at all, for a readable error up front. */
export function sealingAvailable(): boolean {
	return passphrase().trim().length > 0;
}
