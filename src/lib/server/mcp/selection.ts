/**
 * Turning a person's connector choice into servers a turn can call
 * (ADR 0064).
 *
 * The browser sends **ids**, and the URL and the credential are read here. It
 * used to send the URL *and* the `Authorization` header, both out of
 * `localStorage`, which is the defect this ADR exists to close: a credential
 * the client supplies is a credential the client holds.
 *
 * A header arriving from the browser is therefore **ignored**, not honoured.
 * Silently, once per turn, with a log line — refusing the turn would break
 * sessions whose stored servers predate connectors, and honouring it would
 * keep the hole open for exactly as long as one stale tab exists.
 */

import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { bearerFor } from "./oauth";

export interface ResolvedServer {
	name: string;
	url: string;
	headers?: Record<string, string>;
}

/**
 * The connectors this person picked, with their own credentials attached.
 *
 * A connector they have not authorised is left out rather than called without
 * a token: the call would 401, the model would be told a tool failed, and the
 * person would get an answer shaped by a missing capability instead of a
 * prompt to sign in.
 */
export async function resolveSelection(options: {
	connectorIds: string[];
	userId: ObjectId;
}): Promise<{ servers: ResolvedServer[]; needAuthorization: string[] }> {
	const { connectorIds, userId } = options;
	if (connectorIds.length === 0) return { servers: [], needAuthorization: [] };

	const { ObjectId: Oid } = await import("mongodb");
	const ids = connectorIds.filter((id) => Oid.isValid(id)).map((id) => new Oid(id));
	if (ids.length === 0) return { servers: [], needAuthorization: [] };

	// Scoped to the owner, so an id from somebody else's connector resolves to
	// nothing rather than to their credential.
	const connectors = await collections.mcpConnectors.find({ _id: { $in: ids }, userId }).toArray();

	const servers: ResolvedServer[] = [];
	const needAuthorization: string[] = [];

	for (const connector of connectors) {
		if (connector.auth === "none") {
			servers.push({ name: connector.name, url: connector.url });
			continue;
		}
		const bearer = await bearerFor({ connector, userId });
		if (!bearer) {
			needAuthorization.push(connector.name);
			continue;
		}
		servers.push({
			name: connector.name,
			url: connector.url,
			headers: { Authorization: `Bearer ${bearer}` },
		});
	}

	return { servers, needAuthorization };
}

/**
 * Strip credentials from whatever the client sent about ad-hoc servers.
 *
 * The URL is still honoured — selecting a server is the person's choice to
 * make — but any header is dropped. Anything that needs a credential needs to
 * be a connector.
 */
export function withoutClientCredentials(
	sent: { name: string; url: string; headers?: Record<string, string> }[]
): ResolvedServer[] {
	const carried = sent.filter((server) => server.headers && Object.keys(server.headers).length > 0);
	if (carried.length > 0) {
		logger.info(
			{ servers: carried.map((server) => server.name) },
			"mcp_client_headers_ignored: add these as connectors so the credential lives server-side"
		);
	}
	return sent.map(({ name, url }) => ({ name, url }));
}
