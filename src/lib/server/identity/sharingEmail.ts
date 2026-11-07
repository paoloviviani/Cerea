import type { User } from "$lib/types/User";

/**
 * The address sharing matches this user on. An issuer that allows self-registration can hand
 * anyone an account claiming `victim@corp.com`; when it says the address is unverified
 * (`email_verified: false`) nothing shared to that address is theirs. An issuer that does not
 * send the claim is trusted as it always was (the bundled Authelia, whose addresses an
 * administrator typed in, is one).
 */
export function sharingEmail(
	user: Pick<User, "email" | "emailVerified"> | undefined
): string | undefined {
	if (!user?.email) return undefined;
	return user.emailVerified === false ? undefined : user.email;
}
