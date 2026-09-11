/**
 * One connector: re-probe it, start a sign-in, disconnect, delete (ADR 0064).
 *
 * `POST` with `{"action": "..."}` rather than four routes, because these are
 * all "do this to that connector" and each would otherwise be six lines of
 * identical ownership checking.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { probe } from "$lib/server/mcp/discovery";
import { beginAuthorization } from "$lib/server/mcp/oauth";
import { ownedBy, view } from "$lib/server/mcp/connectors";
import { logger } from "$lib/server/logger";

const body = z.object({
	action: z.enum(["authorize", "reprobe", "disconnect"]),
	/** Where to land after a sign-in, within this app. */
	next: z.string().max(512).optional(),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const connector = await ownedBy(params.id as string, user._id);
	if (!connector) error(404, "No such connector.");
	return json(await view(connector, user._id));
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);
	const connector = await ownedBy(params.id as string, user._id);
	if (!connector) error(404, "No such connector.");

	const parsed = body.safeParse(await request.json());
	if (!parsed.success) error(400, "Say which action.");
	const { action, next } = parsed.data;

	if (action === "reprobe") {
		const result = await probe(connector.url);
		const update: Record<string, unknown> = { probedAt: new Date(), updatedAt: new Date() };
		if (result.auth === "oauth") {
			update.auth = "oauth";
			update.oauth = result.oauth;
			update.lastError = undefined;
		} else if (result.auth === "none") {
			// Only downgrade a connector that has no credential of its own: a
			// token-authenticated server answers 400 rather than 401 to our
			// probe, and calling that "no auth" would throw the token away.
			if (connector.auth !== "token") update.auth = "none";
			update.lastError = undefined;
		} else {
			update.lastError = result.reason;
		}
		await collections.mcpConnectors.updateOne({ _id: connector._id }, { $set: update });
		const refreshed = await ownedBy(params.id as string, user._id);
		return json(await view(refreshed ?? connector, user._id));
	}

	if (action === "disconnect") {
		// The authorisation goes; the connector stays, so signing in again is
		// one click rather than re-adding a URL.
		await collections.mcpTokens.deleteMany({ connectorId: connector._id, userId: user._id });
		const refreshed = await ownedBy(params.id as string, user._id);
		return json(await view(refreshed ?? connector, user._id));
	}

	// authorize
	if (connector.auth !== "oauth" || !connector.oauth) {
		error(400, "That connector does not use OAuth.");
	}
	if (!locals.sessionId) {
		error(401, "This needs a session, so the callback can be tied to it.");
	}
	try {
		const url = await beginAuthorization({
			connector,
			userId: user._id,
			sessionId: locals.sessionId,
			next,
		});
		// The URL rather than a redirect: the caller is `fetch` from a dialog,
		// and a 302 there would be followed by the fetch instead of the
		// browser, which is not where a consent screen belongs.
		return json({ authorizeUrl: url });
	} catch (err) {
		logger.warn({ err, connector: connector.name }, "mcp_oauth_begin_failed");
		error(502, err instanceof Error ? err.message : "Could not start the sign-in.");
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	const connector = await ownedBy(params.id as string, user._id);
	if (!connector) error(404, "No such connector.");
	// The tokens go with it. There is no polymorphic-address problem here as
	// there is in the gateway's sharing (ADR 0062), so this is one delete each.
	await collections.mcpTokens.deleteMany({ connectorId: connector._id });
	await collections.mcpConnectors.deleteOne({ _id: connector._id });
	return new Response(null, { status: 204 });
};
