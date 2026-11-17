import { createHash, randomBytes } from "node:crypto";

/** 128 random bits, base64url: 22 characters. Never stored; only its hash is. */
export function newShareToken(): string {
	return randomBytes(16).toString("base64url");
}

export const SHARE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export function hashShareToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}
