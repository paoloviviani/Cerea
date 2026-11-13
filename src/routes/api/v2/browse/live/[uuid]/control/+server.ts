/**
 * Takeover and hand-back of a running browse task (ADR 0116 phase 2a): the owner takes the
 * browser from the sub-agent, which is then paused (it reads nothing and its time does not tick),
 * and gives it back, after which the agent looks at the page afresh and continues.
 *
 * Body `{action: "takeover" | "handback"}`. A scheduled run cannot be taken over (403).
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
	const body = (await request.json().catch(() => null)) as { action?: unknown } | null;
	if (body?.action !== "takeover" && body?.action !== "handback") {
		error(400, "The action is takeover or handback");
	}
	const result = body.action === "takeover" ? await task.takeover() : await task.handBack();
	if (!result.ok) error(result.status, result.message);
	return json({ controller: result.controller });
};
