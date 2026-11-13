/**
 * Open a browser of the user's own on one of their computers (ADR 0116 phase 2a): no browse task,
 * no agent; the user browses with it directly through the live stream (`streamUrl`, the same
 * module and routes as a task's). Like the agent terminal: the computer must be theirs and
 * paired, one browser per computer, closed on request, when the lease is lost, or when idle.
 *
 * Body `{deviceId, url?}`; answers `{id, streamUrl, info}` (info: machine, address, kind). The
 * same gates as "Open browser": the user, the feature switch, the computer is theirs and ready,
 * and the address (http(s) only, bounded, not on the admin's deny list).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { browseMachinesFor } from "$lib/server/browser/availability";
import { requireBrowserUse } from "$lib/server/browser/gate";
import { mongoChoiceStore } from "$lib/server/browser/machineChoice";
import { parseOpenUrl } from "$lib/server/browser/open";
import { openUserBrowser } from "$lib/server/browser/userSession";

const bodySchema = z.object({
	deviceId: z.string().min(1).max(64),
	url: z.string().max(4096).optional(),
});

export const POST: RequestHandler = async ({ locals, request }) => {
	const { userId } = requireBrowserUse(locals);
	if (!request.headers.get("content-type")?.includes("application/json")) error(415, "Send JSON");
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "deviceId (and optionally url) are needed");

	const name = await mongoChoiceStore.nameOf(userId, parsed.data.deviceId);
	if (name === undefined) error(404, "No such computer.");
	const ready = await browseMachinesFor(locals);
	if (!ready.some((m) => m.id === parsed.data.deviceId)) error(409, `${name} is offline.`);

	const address = parseOpenUrl(parsed.data.url);
	if ("error" in address) error(400, address.error);

	const result = await openUserBrowser(
		{ id: userId },
		{ deviceId: parsed.data.deviceId, url: address.url }
	);
	if (!result.ok) error(result.status, result.message);
	return json({ id: result.id, streamUrl: result.streamUrl, info: result.info }, { status: 201 });
};
