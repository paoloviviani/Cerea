/**
 * `/admin` has no content of its own; it is the tabs.
 *
 * Redirecting to the first section rather than inventing a dashboard: there is
 * nothing a landing page here would say that the tabs do not already say, and a
 * page of links to two links is furniture.
 */

import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	redirect(307, `${base}/admin/knowledge`);
};
