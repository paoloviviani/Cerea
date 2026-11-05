/** The reviewer's log across all machines (administrator only), newest first, keyset paging. */
import type { RequestHandler } from "@sveltejs/kit";
import { requireAdmin } from "$lib/server/admin";
import { reviewLogResponse } from "$lib/server/reviewLogApi";

export const GET: RequestHandler = async ({ locals, url }) => {
	await requireAdmin(locals);
	return reviewLogResponse(url);
};
