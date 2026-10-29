/**
 * The old `/admin/instructions` address: that section now lives on the `assistant` tab.
 * Permanent, and carrying the section's anchor so a bookmark still lands on it.
 */

import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	redirect(308, `${base}/admin/assistant#instructions`);
};
