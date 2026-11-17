/**
 * Public artifact links, the owner's side (ADR 0120).
 *
 * GET lists the caller's own links (never a token: only its hash is stored).
 * POST makes one for an artifact of the caller's own chat and returns the link
 * once, in `url`; it cannot be shown again, only replaced (`PATCH rotate`).
 */
import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { createShare, listOwnShares } from "$lib/server/sharing/shares";
import { sharingEnabled } from "$lib/server/sharing/settings";
import { shareUrl, sharedOnAppOrigin } from "$lib/server/sharing/urls";
import { asHttp } from "$lib/server/sharing/http";

const audience = z.enum(["signed_in", "anyone"]);
const expiry = z.union([z.literal(7), z.literal(30), z.literal(90), z.null()]);

const body = z.discriminatedUnion("kind", [
	z.object({
		kind: z.literal("text"),
		conversationId: z.string(),
		identifier: z.string().min(1).max(500),
		version: z.number().int().min(1).optional(),
		audience: audience.optional(),
		expiryDays: expiry.optional(),
	}),
	z.object({
		kind: z.literal("file"),
		conversationId: z.string(),
		name: z.string().min(1).max(500),
		sha256: z.string().regex(/^[0-9a-f]{64}$/),
		audience: audience.optional(),
		expiryDays: expiry.optional(),
	}),
]);

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) error(401, "Login required");
	return json({
		enabled: await sharingEnabled(),
		onAppOrigin: sharedOnAppOrigin(),
		data: await listOwnShares(locals.user._id),
	});
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) error(401, "Login required");
	const parsed = body.safeParse(await request.json().catch(() => null));
	if (!parsed.success || !ObjectId.isValid(parsed.data.conversationId)) {
		error(400, "Say which artifact to share.");
	}
	const input = parsed.data;
	const user = locals.user;
	const made = await asHttp(() =>
		createShare(user, {
			conversationId: new ObjectId(input.conversationId),
			target:
				input.kind === "text"
					? { kind: "text", identifier: input.identifier, version: input.version }
					: { kind: "file", name: input.name, sha256: input.sha256 },
			audience: input.audience,
			expiryDays: input.expiryDays,
		})
	);
	return json(
		{
			id: made.id,
			url: shareUrl(made.token, made.listing.audience),
			onAppOrigin: sharedOnAppOrigin(),
			share: made.listing,
		},
		{ status: 201, headers: { "Cache-Control": "no-store" } }
	);
};
