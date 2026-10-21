/** Forget one of the caller's devices. Another person's id is a 404, not a 403. */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { removeSubscription } from "$lib/server/push/store";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, "Login required");
	if (!(await removeSubscription(locals.user._id, params.id ?? ""))) {
		error(404, "No such device.");
	}
	return json({ data: { ok: true } });
};
