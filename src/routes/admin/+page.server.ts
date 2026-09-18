/**
 * `/admin` has no content of its own; it is the tabs.
 *
 * Redirecting to the first section rather than inventing a dashboard: there is
 * nothing a landing page here would say that the tabs do not already say, and a
 * page of links to two links is furniture.
 */

import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async () => {
	// The first section that exists: with the knowledge pipeline switched off
	// at the deployment level there is no Knowledge tab to land on.
	redirect(307, `${base}/admin/${knowledgeEnabled() ? "knowledge" : "fetch"}`);
};
