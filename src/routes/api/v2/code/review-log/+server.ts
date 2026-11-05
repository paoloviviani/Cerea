/**
 * The reviewer's decisions for the caller's own machines, newest first (ADR 0107). The entry's
 * `userId` is the owner of the machine the ask came from (every ask arrives over the owner's own
 * link), so it is the scope; it comes from the session, and the query can only narrow within it.
 */
import { error, type RequestHandler } from "@sveltejs/kit";
import { requireCodeAgents } from "$lib/server/codeDevices";
import { reviewLogResponse } from "$lib/server/reviewLogApi";

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireCodeAgents(locals);
	if (!locals.user) error(401, "Login required");
	return reviewLogResponse(url, locals.user._id);
};
