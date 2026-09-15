/**
 * `/settings` has no content of its own; it is the tabs.
 *
 * Redirecting to the only section rather than leaving an empty page: there is
 * nothing a landing page here would say that the tab does not already say.
 */

import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	redirect(307, `${base}/settings/application`);
};
