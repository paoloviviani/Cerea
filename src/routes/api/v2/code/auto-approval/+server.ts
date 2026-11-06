/**
 * What the composer needs to compute its line (ADR 0109): whether Auto has a reviewer behind it
 * for this user, and the user's own per-class rows. No instructions, no model name.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { superjsonResponse } from "$lib/server/api/utils/superjsonResponse";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { autoApprovalAvailability } from "$lib/server/agentReview";

export const GET: RequestHandler = async ({ locals }) => {
	await requireCodeAgents(locals);
	if (!locals.user) error(401, "Login required");
	return superjsonResponse(await autoApprovalAvailability(locals.user._id));
};
