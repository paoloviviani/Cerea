import { error } from "@sveltejs/kit";
import { codeAgentsEnabled } from "$lib/server/codeEnabled";
import type { PageServerLoad } from "./$types";

/**
 * The route's own gate: the sidebar hides the row when the flag is off, and
 * this 404s a typed address all the same. The panel's `enabled` prop is the
 * backstop message, not the decision.
 */
export const load: PageServerLoad = async () => {
	if (!codeAgentsEnabled()) {
		error(404, "Coding agents are not enabled in this deployment.");
	}
	return {};
};
