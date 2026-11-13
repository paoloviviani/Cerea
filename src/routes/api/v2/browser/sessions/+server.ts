/**
 * Open a browser of the user's own on one of their computers (ADR 0116 phase 2a): no browse task,
 * no agent; the user browses with it directly through the live stream (`streamUrl`, the same
 * module and routes as a task's). Like the agent terminal: the computer must be theirs and
 * paired, one browser per computer, closed on request, when the lease is lost, or when idle.
 *
 * Body `{deviceId, url?}`; answers `{id, streamUrl, info}` (info: machine, address, kind).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { openUserBrowser } from "$lib/server/browser/userSession";

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, "Unauthorized");
	if (!request.headers.get("content-type")?.includes("application/json")) error(415, "Send JSON");
	const body = (await request.json().catch(() => null)) as {
		deviceId?: unknown;
		url?: unknown;
	} | null;
	if (
		typeof body?.deviceId !== "string" ||
		(body.url !== undefined && typeof body.url !== "string")
	) {
		error(400, "deviceId (and optionally url) are needed");
	}
	const result = await openUserBrowser(
		{ id: locals.user._id },
		{ deviceId: body.deviceId, url: body.url as string | undefined }
	);
	if (!result.ok) error(result.status, result.message);
	return json({ id: result.id, streamUrl: result.streamUrl, info: result.info }, { status: 201 });
};
