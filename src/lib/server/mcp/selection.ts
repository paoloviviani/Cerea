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
import type { McpConnector } from "$lib/types/McpConnector";
import type { McpTurnSelection } from "$lib/types/Conversation";

export interface ResolvedServer {
	name: string;
	url: string;
	headers?: Record<string, string>;
}

/**
 * The headers that authenticate one connector, for one person.
 *
 * `Authorization: Bearer …` is the common case and the default, but the header
 * name is configurable because `X-API-Key` with no prefix is what a real share
 * of servers want — and before connectors existed that case was served by the
 * free-form headers editor, whose values sat in `localStorage`. Migrating
 * those without this would have meant telling people their server "isn't
 * supported any more", which is not a migration.
 *
 * Returns null when there is no usable credential, which the callers treat as
 * "needs authorising" rather than "call it bare".
 */
export async function credentialHeaders(options: {
	connector: McpConnector;
	userId: ObjectId;
}): Promise<Record<string, string> | null> {
	const { connector, userId } = options;
	if (connector.auth === "none") return {};

	const secret = await bearerFor({ connector, userId });
	if (!secret) return null;

	const header = connector.tokenHeader?.trim() || "Authorization";
	// `?? "Bearer "` rather than `|| "Bearer "`: an empty prefix is a real
	// choice (that is exactly what `X-API-Key` wants) and must survive.
	const prefix = connector.tokenPrefix ?? "Bearer ";
	return { [header]: `${prefix}${secret}` };
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

	// Their own, plus the deployment's. An id belonging to *another person's*
	// connector still resolves to nothing — that is the property the tests
	// pair a positive case against — while an administrator's shared connector
	// resolves for everybody, which is what sharing a definition means.
	//
	// The credential is unaffected by this widening and that is the whole
	// design: `credentialHeaders` looks a token up by `(userId, connectorId)`,
	// so a shared Notion connector still reaches each person's own workspace as
	// themselves. Widening the *definition* lookup does not widen the token
	// lookup, and the two must not be merged for convenience.
	const connectors = await collections.mcpConnectors
		.find({ _id: { $in: ids }, $or: [{ userId }, { scope: "deployment" }] })
		.toArray();

	const servers: ResolvedServer[] = [];
	const needAuthorization: string[] = [];

	for (const connector of connectors) {
		if (connector.auth === "none") {
			servers.push({ name: connector.name, url: connector.url });
			continue;
		}
		const headers = await credentialHeaders({ connector, userId });
		if (!headers) {
			needAuthorization.push(connector.name);
			continue;
		}
		servers.push({
			name: connector.name,
			url: connector.url,
			headers,
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

/** The `locals.mcp` a turn runs with (read by `runMcpFlow`). */
export interface McpLocals {
	unavailable: Array<{ name: string; reason: string }>;
	selectedServerNames?: string[];
	selectedServers: ResolvedServer[];
}

/**
 * Build a turn's MCP servers from its selection, resolving connectors
 * server-side with this person's own credential.
 *
 * One function for every way a turn runs, and that is the point of it: a turn
 * that parks — on `execute_code`, a timer, a tool approval — is resumed later
 * with no request to read a selection from. Before this, the resume rebuilt the
 * identity but not the connectors, so everything after the first
 * `execute_code` ran with the built-in tools only and the model went looking
 * for the missing connector among the skills.
 */
export async function mcpLocalsFor(
	selection: McpTurnSelection,
	userId?: ObjectId
): Promise<McpLocals> {
	const resolved = userId
		? await resolveSelection({ connectorIds: selection.connectorIds, userId })
		: { servers: [], needAuthorization: [] };

	if (resolved.needAuthorization.length > 0) {
		// Left out rather than called without a token: a 401 would reach the
		// model as "that tool failed" and the person would get an answer
		// shaped by a missing capability instead of a prompt to sign in.
		logger.info(
			{ connectors: resolved.needAuthorization },
			"mcp_connector_not_authorized: left out of this turn"
		);
	}

	return {
		// Told to the model this turn (`runMcpFlow`), so it says the
		// connector needs attention instead of improvising its tools.
		unavailable: resolved.needAuthorization.map((name) => ({
			name,
			reason: "not signed in, or its token is missing",
		})),
		selectedServerNames: selection.serverNames,
		selectedServers: [
			...selection.customServers.map(({ name, url }) => ({ name, url })),
			// Connectors **last**, because `runMcpFlow` deduplicates by name
			// and the later entry wins. Two of these can share a name — a
			// connector called "Notion" beside a stale custom server of the
			// same name in somebody's localStorage — and the one that must
			// survive is the one carrying a credential this browser never
			// held.
			...resolved.servers,
		],
	};
}
