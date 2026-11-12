/**
 * The user's default computer for browsing (ADR 0116, C109): `{deviceId}` makes one of their paired
 * computers the default (there is one per user), `{deviceId: null}` clears it.
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { requireBrowserUse } from "$lib/server/browser/gate";
import { setDefaultDevice } from "$lib/server/browser/machineChoice";

const bodySchema = z.object({ deviceId: z.string().min(1).max(64).nullable() });

export const PUT: RequestHandler = async ({ locals, request }) => {
	const { userId } = requireBrowserUse(locals);
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Invalid request");
	// Another user's computer, a revoked one or a bad id is a 404, like every machine route.
	if (!(await setDefaultDevice(userId, parsed.data.deviceId))) error(404, "No such computer.");
	return json({ deviceId: parsed.data.deviceId });
};
