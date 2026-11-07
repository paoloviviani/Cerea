import { collections } from "$lib/server/database";
import type { User } from "$lib/types/User";

/**
 * The address sharing matches this user on. An issuer that allows self-registration can hand
 * anyone an account claiming `victim@corp.com`; when it says the address is unverified
 * (`email_verified: false`) nothing shared to that address is theirs. An issuer that does not
 * send the claim is trusted as it always was (the bundled Authelia, whose addresses an
 * administrator typed in, is one).
 *
 * A row from before the claim was stored has `emailVerified` undefined. On an issuer that is known
 * to send the claim (some other row of the same issuer carries it) such a row is unproven until its
 * next login writes the claim, so it is not matched either (`issuerSendsClaim`).
 */
export function sharingEmail(
	user: Pick<User, "email" | "emailVerified"> | undefined,
	issuerSendsClaim = false
): string | undefined {
	if (!user?.email) return undefined;
	if (user.emailVerified === false) return undefined;
	if (user.emailVerified === undefined && issuerSendsClaim) return undefined;
	return user.email;
}

const CACHE_MS = 60_000;
const known = new Map<string, { at: number; value: boolean }>();

/** Whether this issuer has ever sent `email_verified` (cached a minute). */
export async function issuerSendsEmailVerified(issuer: string | undefined): Promise<boolean> {
	if (!issuer) return false;
	const key = issuer;
	const hit = known.get(key);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
	const found = await collections.users.findOne(
		{ issuer, emailVerified: { $type: "bool" } },
		{ projection: { _id: 1 } }
	);
	const value = found !== null;
	known.set(key, { at: Date.now(), value });
	return value;
}

/** Test seam: state what an issuer is known to do without touching the shared database. */
export function _seedIssuerClaim(issuer: string, sends: boolean): void {
	known.set(issuer, { at: Date.now(), value: sends });
}

export function _resetIssuerClaimCache(): void {
	known.clear();
}

/** `sharingEmail` with the issuer lookup done. */
export async function sharingEmailFor(
	user: Pick<User, "email" | "emailVerified" | "issuer"> | undefined
): Promise<string | undefined> {
	if (!user?.email) return undefined;
	const sends =
		user.emailVerified === undefined ? await issuerSendsEmailVerified(user.issuer) : false;
	return sharingEmail(user, sends);
}
