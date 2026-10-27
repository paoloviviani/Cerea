/**
 * Turning the deployment's policies, a person's switches and a conversation's
 * loaded set into the servers a turn can call (ADR 0064, ADR 0104).
 *
 * The URL and the credential are read here, on the server. The browser used to
 * send both (out of `localStorage`) and now sends no choice at all: a
 * credential the client supplies is a credential the client holds, and a
 * selection it stores can be weeks stale.
 */

import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { bearerFor } from "./oauth";
import { resolveConnectors, type BlockedConnector, type TurnConnector } from "./turnConnectors";
import type { McpConnector } from "$lib/types/McpConnector";

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

/** The `locals.mcp` a turn runs with (read by `runMcpFlow`). */
export interface McpLocals {
	/** Loaded connectors that could not be opened this turn, with why. */
	unavailable: Array<{ name: string; reason: string }>;
	/** Every connector that is on for this person: the assistant's list, and what `load_tools` can load. */
	connectors: TurnConnector[];
	/** Connectors left out of it for the assistant to explain: switched off, or needing a sign-in. */
	blocked: BlockedConnector[];
	/** The keys loaded at the start of the turn: always loaded, then the conversation's, in order. */
	loadedKeys: string[];
	/** The loaded connectors' servers, with this person's credential, in `loadedKeys` order. */
	servers: ResolvedServer[];
}

/**
 * Build a turn's connectors (ADR 0104): the ones on for this person, and which
 * are loaded.
 *
 * One function for every way a turn runs, and that is the point of it: a turn
 * that parks (on `execute_code`, a timer, a tool approval) is resumed later
 * with no request to read anything from, and used to run with the built-in
 * tools only. The inputs are the deployment's policies, the person's own
 * switches and the conversation's loaded set, never the browser.
 *
 * Only the loaded connectors are opened here (their credential looked up);
 * the rest are lines for the assistant and cost nothing.
 */
export async function mcpLocalsFor(
	conv: { loadedConnectors?: string[] },
	userId?: ObjectId
): Promise<McpLocals> {
	const { connectors, blocked } = await resolveConnectors(userId);
	const byKey = new Map(connectors.map((c) => [c.key, c]));
	const alwaysKeys = connectors.filter((c) => c.alwaysLoaded).map((c) => c.key);
	// Always loaded first, then what the assistant loaded, in the order it did. A key that is no
	// longer on for this person (switched off, deleted, signed out) is simply not loaded.
	const wanted = [...new Set([...alwaysKeys, ...(conv.loadedConnectors ?? [])])].filter((key) =>
		byKey.has(key)
	);
	const unavailable: McpLocals["unavailable"] = [];
	const servers: ResolvedServer[] = [];
	const loadedKeys: string[] = [];
	const opened = await Promise.all(
		wanted.map(async (key) => {
			try {
				return (await byKey.get(key)?.open()) ?? { unavailable: "it is not available" };
			} catch (err) {
				logger.warn({ err: String(err), key }, "mcp_connector_open_failed");
				return { unavailable: "it could not be opened" };
			}
		})
	);
	opened.forEach((result, index) => {
		const key = wanted[index];
		const name = byKey.get(key)?.name ?? key;
		if ("server" in result) {
			servers.push(result.server);
			loadedKeys.push(key);
		} else {
			// Left out rather than called without a token: a 401 would reach the model as
			// "that tool failed" and the person would get an answer shaped by a missing capability.
			unavailable.push({ name, reason: result.unavailable });
			logger.info({ connector: name }, "mcp_connector_not_opened: left out");
		}
	});
	return { unavailable, connectors, blocked, loadedKeys, servers };
}
