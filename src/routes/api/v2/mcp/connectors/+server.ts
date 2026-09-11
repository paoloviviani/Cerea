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
import { view, viewsFor } from "$lib/server/mcp/connectors";
import type { McpConnector } from "$lib/types/McpConnector";

const create = z.object({
	name: z.string().trim().min(1).max(128),
	// http is refused: a bearer token on a plaintext connection is the thing
	// this ADR exists to stop, and localhost is not a case we serve.
	url: z.string().trim().url().startsWith("https://", "a connector must be served over HTTPS"),
	/** A static credential, for a server that takes one instead of OAuth. */
	token: z.string().trim().min(1).optional(),
});

function requireUser(locals: App.Locals) {
	if (!locals.user) error(401, "Login required");
	return locals.user;
}

export const GET: RequestHandler = async ({ locals }) => {
	const user = requireUser(locals);
	return json({ data: await viewsFor(user._id) });
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
	const { name, url, token } = parsed.data;

	const now = new Date();
	const connector: McpConnector = {
		_id: new ObjectId(),
		userId: user._id,
		name,
		url,
		auth: token ? "token" : "none",
		...(token ? { tokenSealed: seal(token) } : {}),
		createdAt: now,
		updatedAt: now,
	};

	// A static token is taken at its word: the person supplying one is saying
	// this server wants a header, and probing would only tell us it is happy.
	if (!token) {
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
	}

	await collections.mcpConnectors.insertOne(connector);
	return json(await view(connector, user._id), { status: 201 });
};
