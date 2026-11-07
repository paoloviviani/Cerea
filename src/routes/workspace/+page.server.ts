import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { workspaceRedirect } from "$lib/utils/workspaceTabs";
import type { PageServerLoad } from "./$types";

/**
 * Old tab addresses (`?tab=local`, `?tab=custom`) land on the section that
 * absorbed them. Done here rather than in the panel so a bookmark, a link in a
 * sent email and an in-app navigation all arrive in one hop.
 */
export const load: PageServerLoad = async ({ url }) => {
	const target = workspaceRedirect(url);
	if (target) redirect(302, `${base}/workspace${target}`);
	return {};
};
