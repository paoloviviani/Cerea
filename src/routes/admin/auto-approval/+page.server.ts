/**
 * The old `/admin/auto-approval` address: Auto-approval is now a section of the `agents` tab.
 * Permanent, and carrying the section's anchor so a bookmark still lands on it.
 */

import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	redirect(308, `${base}/admin/agents#auto-approval`);
};
