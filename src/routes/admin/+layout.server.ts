/**
 * The admin area's gate.
 *
 * Asked once here rather than in each page, so a section added later cannot
 * forget to ask. It does **not** throw on refusal: the layout renders an
 * explanation instead, because "you are signed in with a local password rather
 * than the identity provider" and "the provider knows you but the gateway does
 * not call you an administrator" send somebody to two different places, and a
 * bare 403 says neither.
 *
 * The gate here is for *navigation*. Every route that changes something calls
 * `requireAdmin` itself — a page that renders is not a permission.
 */

import { callerIdentity } from "$lib/server/admin";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
	const identity = await callerIdentity(locals);
	return {
		identity,
		// Told apart so the page can say which is wrong. `signedIn` without
		// `identity` means the session is not one the gateway accepts — a local
		// password login, or one predating the token.
		signedIn: Boolean(locals.user),
	};
};
