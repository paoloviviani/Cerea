/**
 * The gateway's answer to "is this person an administrator", for the
 * sidebar's Admin link.
 *
 * Asked here, once per navigation, rather than remembered on the chat's own
 * user record: the chat's `user.isAdmin` comes from a HuggingFace
 * organisation claim and means nothing in this deployment — the admin panel's
 * gate is the gateway's answer (`GET /v1/me`, via `callerIdentity`), and the
 * link should open only for the people that same answer admits. Signed-out
 * visitors and sessions the gateway refuses both get `false`, which hides
 * the link and nothing else — the panel's own gate still decides.
 */
import { callerIdentity } from "$lib/server/admin";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals }) => {
	const identity = await callerIdentity(locals);
	return {
		gatewayIsAdmin: identity?.isAdmin === true,
	};
};
