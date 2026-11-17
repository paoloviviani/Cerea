import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { ObjectId } from "mongodb";
import { requireAdmin } from "$lib/server/admin";
import { revokeShare } from "$lib/server/sharing/shares";

export const DELETE: RequestHandler = async ({ locals, params }) => {
	await requireAdmin(locals);
	if (!locals.user) error(401, "Login required");
	if (!ObjectId.isValid(params.id)) error(404, "No such link.");
	const done = await revokeShare({ id: locals.user._id, admin: true }, new ObjectId(params.id));
	if (!done) error(404, "No such link.");
	return json({ ok: true });
};
