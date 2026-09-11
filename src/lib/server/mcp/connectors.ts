/**
 * Reading connectors, and what the browser is allowed to know about them
 * (ADR 0064).
 *
 * The view carries no credential and no sealed value — only *whether* this
 * person has one. That is the whole point of moving the token server-side, and
 * it would be undone by a convenient `token` field on the way out.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import type { McpConnector, McpConnectorView } from "$lib/types/McpConnector";

/** One connector as the client sees it. */
export async function view(connector: McpConnector, userId: ObjectId): Promise<McpConnectorView> {
	let connected = false;
	if (connector.auth === "token") {
		connected = Boolean(connector.tokenSealed);
	} else if (connector.auth === "oauth") {
		connected = Boolean(
			await collections.mcpTokens.findOne(
				{ connectorId: connector._id, userId },
				{ projection: { _id: 1 } }
			)
		);
	} else {
		// Nothing to authenticate with, so it is usable as it stands.
		connected = true;
	}

	return {
		id: connector._id.toString(),
		name: connector.name,
		url: connector.url,
		auth: connector.auth,
		connected,
		// Whether a sign-in can even be offered: OAuth, discovered, and either
		// registerable or already registered.
		canAuthorize:
			connector.auth === "oauth" &&
			Boolean(connector.oauth) &&
			Boolean(connector.oauth?.registrationEndpoint || connector.registration),
		scopesSupported: connector.oauth?.scopesSupported,
		issuer: connector.oauth?.issuer,
		lastError: connector.lastError,
		updatedAt: connector.updatedAt.toISOString(),
	};
}

/** Everything this person has, newest activity first. */
export async function viewsFor(userId: ObjectId): Promise<McpConnectorView[]> {
	const rows = await collections.mcpConnectors
		.find({ userId })
		.sort({ updatedAt: -1 })
		.limit(200)
		.toArray();
	return Promise.all(rows.map((row) => view(row, userId)));
}

/**
 * One connector this person owns, or null.
 *
 * Null for both "no such connector" and "not yours", deliberately: telling
 * those apart confirms that somebody else's connector exists.
 */
export async function ownedBy(id: string, userId: ObjectId): Promise<McpConnector | null> {
	const { ObjectId: Oid } = await import("mongodb");
	if (!Oid.isValid(id)) return null;
	return collections.mcpConnectors.findOne({ _id: new Oid(id), userId });
}
