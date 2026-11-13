/**
 * The user's own input to the browser page while they have taken over (ADR 0116 phase 2a): mouse,
 * touch, special keys and text, in the page's CSS pixels (the `w` x `h` of the frames). Rate
 * limited per task; refused unless the user is in control. It is the user's own action, so it is
 * not classified or approved, and nothing about it is logged.
 *
 * Body `{events: InputEvent[]}` (at most 64).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { liveTaskFor } from "$lib/server/browser/liveView";

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, "Unauthorized");
	if (!request.headers.get("content-type")?.includes("application/json")) {
		error(415, "Send JSON");
	}
	const task = liveTaskFor(params.uuid ?? "", locals.user._id.toString());
	if (!task) error(404, "No such running browser task");
	const body = await request.json().catch(() => null);
	const result = await task.input(body);
	if (!result.ok) error(result.status, result.message);
	return json({ sent: result.sent });
};
