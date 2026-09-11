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
import { beginAuthorization, staticRegistration } from "$lib/server/mcp/oauth";
import { ownedBy, usableBy, view } from "$lib/server/mcp/connectors";
import { callerIdentity } from "$lib/server/admin";
import { credentialHeaders } from "$lib/server/mcp/selection";
import { listTools } from "$lib/server/mcp/health";
import { seal } from "$lib/server/mcp/secretBox";
import { logger } from "$lib/server/logger";

const body = z.object({
	action: z.enum(["authorize", "reprobe", "disconnect", "check", "update"]),
	/** Where to land after a sign-in, within this app. */
	next: z.string().max(512).optional(),

	// `update` only. Each is optional because editing a name should not
	// require resending a credential — and an absent `token` therefore means
	// "leave it alone", never "clear it".
	name: z.string().trim().min(1).max(128).optional(),
	url: z
		.string()
		.trim()
		.url()
		.startsWith("https://", "a connector must be served over HTTPS")
		.optional(),
	token: z.string().trim().min(1).optional(),
	tokenHeader: z.string().trim().max(128).optional(),
	tokenPrefix: z.string().max(32).optional(),
	/** Explicitly drop the stored token, which `token: undefined` does not. */
	clearToken: z.boolean().optional(),
	/**
	 * Static OAuth credentials, settable after the fact.
	 *
	 * This is the recovery path and the reason `update` carries them: a
	 * connector whose provider offers no `registration_endpoint` is created
	 * with `canAuthorize: false` and a disabled button, and pasting a client id
	 * here is what turns it into something that can be signed in to — without
	 * re-typing the URL or losing the row.
	 */
	clientId: z.string().trim().min(1).max(512).optional(),
	clientSecret: z.string().trim().min(1).max(2048).optional(),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals, params }) => {
	const user = requireUser(locals);
	// Usable, not owned: a deployment connector is readable by everybody it
	// is offered to, which is what a row needs in order to render.
	const connector = await usableBy(params.id as string, user._id);
	if (!connector) error(404, "No such connector.");
	const identity = await callerIdentity(locals);
	return json(await view(connector, user._id, identity?.isAdmin ?? false));
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	const user = requireUser(locals);

	const parsed = body.safeParse(await request.json());
	if (!parsed.success) error(400, "Say which action.");
	const { action, next } = parsed.data;

	// Two different permissions, and conflating them was the thing to get right
	// here. **Using** a connector — signing in to it, checking it, disconnecting
	// your own token — is open to everybody it is offered to. **Changing** one —
	// its URL, its credentials, its existence — belongs to whoever owns it, and
	// for a deployment connector that is an administrator, because the change
	// lands on everybody else's requests too.
	const identity = await callerIdentity(locals);
	const isAdmin = identity?.isAdmin ?? false;
	const changes = action === "update" || action === "reprobe";
	const connector = changes
		? await ownedBy(params.id as string, user._id, isAdmin)
		: await usableBy(params.id as string, user._id);
	if (!connector) {
		// 404 rather than 403 for a connector that exists but is not this
		// person's to change: telling those apart confirms it exists.
		error(404, "No such connector.");
	}

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
		const refreshed = await usableBy(params.id as string, user._id);
		return json(await view(refreshed ?? connector, user._id, isAdmin));
	}

	if (action === "check") {
		// The health check the old server list had, moved server-side — which
		// is what makes it work at all here: the credential is sealed in the
		// database, so a browser-side check could never have used it.
		const headers = await credentialHeaders({ connector, userId: user._id });
		if (!headers) {
			error(400, "Sign in to this connector first, or give it a token.");
		}
		const result = await listTools(connector.url, headers);
		await collections.mcpConnectors.updateOne(
			{ _id: connector._id },
			{
				$set: {
					checkedAt: new Date(),
					updatedAt: new Date(),
					// Names and descriptions only. An input schema is large, is
					// not shown, and would put arbitrary third-party JSON in a
					// document we read on every listing.
					tools: result.ok
						? result.tools.map(({ name, description }) => ({ name, description }))
						: [],
					...(result.ok ? {} : { lastError: result.error.slice(0, 500) }),
				},
				// `$unset` rather than `$set: undefined`: the driver does not
				// drop undefined by default, so that writes a literal null and
				// the field stops matching its own `string | undefined` type.
				...(result.ok ? { $unset: { lastError: "" } } : {}),
			}
		);
		const refreshed = await usableBy(params.id as string, user._id);
		return json(await view(refreshed ?? connector, user._id, isAdmin));
	}

	if (action === "update") {
		const set: Record<string, unknown> = { updatedAt: new Date() };
		// `""` is the value `$unset` wants; the driver's types insist on it
		// rather than `unknown`, and they are right to.
		const unset: Record<string, ""> = {};

		if (parsed.data.name) set.name = parsed.data.name;
		if (parsed.data.url && parsed.data.url !== connector.url) {
			set.url = parsed.data.url;
			// The old discovery described a different server, and a stale
			// authorization endpoint is worse than none: it would send somebody
			// to consent for a resource they are no longer adding.
			unset.oauth = "";
			unset.registration = "";
			unset.probedAt = "";
			unset.tools = "";
			unset.checkedAt = "";
			set.auth = connector.auth === "oauth" ? "none" : connector.auth;
		}

		if (parsed.data.clearToken) {
			unset.tokenSealed = "";
			unset.tokenHeader = "";
			unset.tokenPrefix = "";
			if (connector.auth === "token") set.auth = "none";
		} else if (parsed.data.token) {
			set.tokenSealed = seal(parsed.data.token);
			set.auth = "token";
			if (parsed.data.tokenHeader) set.tokenHeader = parsed.data.tokenHeader;
			if (parsed.data.tokenPrefix !== undefined) set.tokenPrefix = parsed.data.tokenPrefix;
		} else if (connector.auth === "token") {
			// Editing the header of a connector whose secret is staying put.
			if (parsed.data.tokenHeader) set.tokenHeader = parsed.data.tokenHeader;
			if (parsed.data.tokenPrefix !== undefined) set.tokenPrefix = parsed.data.tokenPrefix;
		}

		if (parsed.data.clientId) {
			// A URL change above asks to drop the registration; supplying one
			// in the same call asks to set it. Mongo refuses a field in both
			// `$set` and `$unset`, and the explicit value is the later intent.
			delete unset.registration;
			set.registration = staticRegistration({
				clientId: parsed.data.clientId,
				clientSecret: parsed.data.clientSecret,
			});
			set.auth = "oauth";
			// Any sign-in held under the old client id is void: the tokens were
			// issued to a different client, and keeping them would show a
			// connector as connected while every call 401s.
			await collections.mcpTokens.deleteMany({ connectorId: connector._id });
			// The recorded failure was "no way to register a client", and that
			// is precisely what has just been answered.
			unset.lastError = "";
		}

		await collections.mcpConnectors.updateOne(
			{ _id: connector._id },
			{ $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) }
		);
		const refreshed = await usableBy(params.id as string, user._id);
		return json(await view(refreshed ?? connector, user._id, isAdmin));
	}

	if (action === "disconnect") {
		// The authorisation goes; the connector stays, so signing in again is
		// one click rather than re-adding a URL.
		await collections.mcpTokens.deleteMany({ connectorId: connector._id, userId: user._id });
		const refreshed = await usableBy(params.id as string, user._id);
		return json(await view(refreshed ?? connector, user._id, isAdmin));
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
	const identity = await callerIdentity(locals);
	const connector = await ownedBy(params.id as string, user._id, identity?.isAdmin ?? false);
	if (!connector) error(404, "No such connector.");
	// The tokens go with it. There is no polymorphic-address problem here as
	// there is in the gateway's sharing (ADR 0062), so this is one delete each.
	await collections.mcpTokens.deleteMany({ connectorId: connector._id });
	await collections.mcpConnectors.deleteOne({ _id: connector._id });
	return new Response(null, { status: 204 });
};
