/**
 * What the composer needs to label its third step and compute its line (ADR 0107): whether Auto has a
 * reviewer behind it here, and the administrator's per-class rows. No instructions, no model name.
 */
import { json, type RequestHandler } from "@sveltejs/kit";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { autoApprovalAvailability } from "$lib/server/agentReview";

export const GET: RequestHandler = async ({ locals }) => {
	await requireCodeAgents(locals);
	return json(await autoApprovalAvailability());
};
