/**
 * MCP connectors: what this person has, and adding one (ADR 0064).
 *
 * Adding one **probes the server** rather than asking somebody to declare how
 * it authenticates. A remote MCP server says so itself: a 401 names its
 * protected-resource metadata, that names an authorization server, and that
 * publishes its endpoints. So the form is a URL and a name, and the answer to
 * "does this need OAuth" is the protocol's rather than a guess.
 *
 * A static token is still offered, because the requirement names both, and it
 * goes to the same sealed server-side store — the point is where a credential
 * lives, not how it was obtained.
 */

import { error, json, type RequestHandler } from "@sveltejs/kit";
import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { probe } from "$lib/server/mcp/discovery";
import { seal, sealingAvailable } from "$lib/server/mcp/secretBox";
import { staticRegistration } from "$lib/server/mcp/oauth";
import { view, viewsFor } from "$lib/server/mcp/connectors";
import { callerIdentity, requireAdmin } from "$lib/server/admin";
import type { McpConnector } from "$lib/types/McpConnector";

const create = z.object({
	name: z.string().trim().min(1).max(128),
	// http is refused: a bearer token on a plaintext connection is the thing
	// this ADR exists to stop, and localhost is not a case we serve.
	url: z.string().trim().url().startsWith("https://", "a connector must be served over HTTPS"),
	/**
	 * How it authenticates — chosen, rather than inferred from whether a token
	 * was typed.
	 *
	 * `auto` is the default and asks the server, which is the right answer
	 * nearly always. The explicit modes exist for the two cases a probe cannot
	 * settle: a server wanting a static token answers identically whether or
	 * not we hold one, and a server behind something that swallows its own 401
	 * has to be told.
	 */
	authMode: z.enum(["auto", "none", "token", "oauth", "oauth_static"]).default("auto"),
	/**
	 * For `oauth_static` — credentials an operator already holds, used instead
	 * of dynamic registration. Metadata discovery still runs; only RFC 7591 is
	 * skipped, because a provider is free not to offer it.
	 */
	clientId: z.string().trim().min(1).max(512).optional(),
	clientSecret: z.string().trim().min(1).max(2048).optional(),
	/** A static credential, for a server that takes one instead of OAuth. */
	token: z.string().trim().min(1).optional(),
	/** Which header carries it. `Authorization` unless said otherwise. */
	tokenHeader: z.string().trim().max(128).optional(),
	/**
	 * What precedes it in that header. An empty string is a real answer —
	 * `X-API-Key` takes the value bare — so this is not defaulted by `||`.
	 */
	tokenPrefix: z.string().max(32).optional(),
	/**
	 * `deployment` offers it to everybody and requires an administrator.
	 * Defaults to `user`: a connector somebody adds for themselves must never
	 * become the whole deployment's by omission.
	 */
	scope: z.enum(["user", "deployment"]).default("user"),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	// Asked once per listing, and it decides only whether the *manage*
	// buttons render — never what is listed. Everybody sees the deployment's
	// connectors, because they are offered to them.
	const identity = await callerIdentity(locals);
	return json({ data: await viewsFor(user._id, identity?.isAdmin ?? false) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const user = requireUser(locals);
	if (!sealingAvailable()) {
		// Said up front rather than at the moment a token would be written,
		// because the alternative is a connector that looks added and cannot
		// hold a credential.
		error(
			503,
			"This deployment has no CHAT_SECRET_KEY, so connector credentials cannot be stored."
		);
	}

	const parsed = create.safeParse(await request.json());
	if (!parsed.success) {
		error(400, parsed.error.issues[0]?.message ?? "That connector is not valid.");
	}
	const { name, url, authMode, token, tokenHeader, tokenPrefix, clientId, clientSecret, scope } =
		parsed.data;

	if (scope === "deployment") {
		// Checked before the probe, so a non-administrator does not cause an
		// outbound request to somebody else's server on their way to a 403.
		await requireAdmin(locals);
	}

	if (authMode === "token" && !token) {
		error(400, "That auth mode needs a token.");
	}
	if (authMode === "oauth_static" && !clientId) {
		error(400, "Static OAuth needs the client id you registered with the provider.");
	}

	const now = new Date();
	const connector: McpConnector = {
		_id: new ObjectId(),
		userId: user._id,
		scope,
		name,
		url,
		auth: "none",
		createdAt: now,
		updatedAt: now,
	};

	if (token) {
		connector.auth = "token";
		connector.tokenSealed = seal(token);
		if (tokenHeader) connector.tokenHeader = tokenHeader;
		if (tokenPrefix !== undefined) connector.tokenPrefix = tokenPrefix;
	}

	// A token is taken at its word — the person supplying one is saying this
	// server wants a header, and a probe would only tell us it is unhappy
	// without it. Everything else asks the server, which is what makes "how
	// does this authenticate" the protocol's answer rather than a guess.
	if (authMode === "auto" && !token) {
		const result = await probe(url);
		connector.probedAt = new Date();
		if (result.auth === "oauth") {
			connector.auth = "oauth";
			connector.oauth = result.oauth;
		} else if (result.auth === "unknown") {
			// Kept, not refused. "It asks for authentication and we cannot work
			// out how" is worth showing on the row so somebody can add a token
			// instead, and discarding it would lose the URL they just typed.
			connector.lastError = result.reason;
		}
	} else if (authMode === "oauth" || authMode === "oauth_static") {
		// Asked for explicitly, so a discovery failure is an error worth
		// showing rather than a quiet fall back to "no auth" — which would
		// produce a connector that looks fine and 401s on first use.
		const result = await probe(url);
		connector.probedAt = new Date();
		connector.auth = "oauth";
		if (result.auth === "oauth") {
			connector.oauth = result.oauth;
		} else {
			connector.lastError =
				result.auth === "unknown"
					? result.reason
					: "this server does not advertise OAuth; re-check it or give it a token instead";
		}
		if (authMode === "oauth_static" && clientId) {
			// Kept even when discovery failed. The credentials are what the
			// person came here to supply, and discarding them because the
			// server was briefly unreachable would mean typing a secret twice.
			connector.registration = staticRegistration({ clientId, clientSecret });
		}
	}

	await collections.mcpConnectors.insertOne(connector);
	return json(await view(connector, user._id, scope === "deployment"), { status: 201 });
};
