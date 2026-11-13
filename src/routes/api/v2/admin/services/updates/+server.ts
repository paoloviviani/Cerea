/**
 * "Check for updates". A POST, because it reaches outside on the
 * administrator's say-so: never a page load, never a background job.
 */

import { json, type RequestHandler } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/admin";
import { checkForUpdates } from "$lib/server/services/updates";

export const POST: RequestHandler = async ({ locals }) => {
	await requireAdmin(locals);
	return json(await checkForUpdates(locals.token), { headers: { "cache-control": "no-store" } });
};
