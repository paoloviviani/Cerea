import { error, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { codeAgentsAllowedFor, codeAgentsEnabled } from "$lib/server/codeEnabled";
import type { PageServerLoad } from "./$types";

/**
 * The route's own gate: the sidebar hides the row when the flag is off, and
 * this 404s a typed address all the same. A person without the capability
 * (ADR 0096) gets the same 404, with their own reason — the panel reads as
 * hidden rather than as a refusal to argue with. The panel's `enabled` prop
 * is the backstop message, not the decision.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!codeAgentsEnabled()) {
		error(404, "Coding agents are not turned on here.");
	}
	if (!(await codeAgentsAllowedFor(locals))) {
		error(404, "Coding agents are not available for your account.");
	}

	// Agent schedules moved to the one Schedules page; old links keep working,
	// with every other query parameter (the editor's prefill, a schedule id) intact.
	if (url?.searchParams.get("view") === "schedules") {
		const query = new URLSearchParams(url.searchParams);
		query.delete("view");
		query.set("kind", "agent");
		redirect(307, `${base}/schedules?${query}`);
	}
	return {};
};
