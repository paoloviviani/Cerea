import { error } from "@sveltejs/kit";
import { codeAgentsAllowedFor, codeAgentsEnabled } from "$lib/server/codeEnabled";
import type { PageServerLoad } from "./$types";

/**
 * The route's own gate: the sidebar hides the row when the flag is off, and
 * this 404s a typed address all the same. A person without the capability
 * (ADR 0096) gets the same 404, with their own reason — the panel reads as
 * hidden rather than as a refusal to argue with. The panel's `enabled` prop
 * is the backstop message, not the decision.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!codeAgentsEnabled()) {
		error(404, "Coding agents are not turned on here.");
	}
	if (!(await codeAgentsAllowedFor(locals))) {
		error(404, "Coding agents are not available for your account.");
	}
	return {};
};
