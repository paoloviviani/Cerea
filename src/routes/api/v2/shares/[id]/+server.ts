import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { revokeShare, updateShare } from "$lib/server/sharing/shares";
import { shareUrl } from "$lib/server/sharing/urls";
import { asHttp } from "$lib/server/sharing/http";

const patch = z.object({
	audience: z.enum(["signed_in", "anyone"]).optional(),
	expiryDays: z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]).optional(),
	toLatest: z.boolean().optional(),
	rotate: z.boolean().optional(),
});

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) error(401, "Login required");
	if (!ObjectId.isValid(params.id)) error(404, "No such link.");
	const parsed = patch.safeParse(await request.json().catch(() => null));
	if (!parsed.success) error(400, "Nothing to change.");
	const user = locals.user;
	const id = new ObjectId(params.id);
	const changed = await asHttp(() => updateShare(user, id, parsed.data));
	return json(
		{
			share: changed.listing,
			...(changed.token ? { url: shareUrl(changed.token, changed.listing.audience) } : {}),
		},
		{ headers: { "Cache-Control": "no-store" } }
	);
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) error(401, "Login required");
	if (!ObjectId.isValid(params.id)) error(404, "No such link.");
	const done = await revokeShare({ id: locals.user._id }, new ObjectId(params.id));
	if (!done) error(404, "No such link.");
	return json({ ok: true });
};
