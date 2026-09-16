/**
 * The overlay-as-a-page wrapper is gone: the knowledge manager is a tab of the
 * workspace now. This address predates that and people link to it, so it
 * redirects to the equivalent workspace address rather than rotting.
 *
 * `302`, not a permanent code: the redirect is a courtesy for old links, not a
 * published fact about the address space, and a cached permanent redirect is
 * harder to walk back than a temporary one.
 */
import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";

export function load(): never {
	redirect(302, `${base}/workspace?tab=kb`);
}
