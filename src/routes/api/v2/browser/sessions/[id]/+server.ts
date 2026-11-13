/** Close the caller's own browser session (404 for anyone else's or one that is gone). */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { closeUserBrowser } from "$lib/server/browser/userSession";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, "Unauthorized");
	if (!(await closeUserBrowser(locals.user._id.toString(), params.id ?? ""))) {
		error(404, "No such browser session");
	}
	return json({ closed: true });
};
