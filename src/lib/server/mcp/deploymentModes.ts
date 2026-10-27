/**
 * How the deployment offers its own connectors to people.
 *
 * The deployment's connectors are the `.env` servers (`MCP_SERVERS`) and the
 * ones an administrator adds (`scope: "deployment"`). Each has a mode:
 *
 * - `always` (the default, so a row is only ever stored for the other two):
 *   offered on every turn, with no switch. The turn adds it whatever the
 *   browser sent.
 * - `optional`: offered with a switch; on a turn only when that person chose it.
 * - `off`: offered to nobody, whatever the browser sent.
 *
 * The browser is not asked. Its stored selection (`mcp:selected-ids`,
 * `mcp:disabled-base-ids`) can be stale for weeks, and "an always-on connector
 * a tab switched off" or "an off one a tab switched on" are exactly the two
 * failures this exists to prevent. Every path that builds a turn's servers
 * goes through here: the turn route, the parked-turn and tool-approval
 * sweepers (`mcpLocalsFor`), and `runMcpFlow`'s own list of `.env` servers.
 *
 * Read from Mongo on each use rather than cached, so a change takes effect on
 * the next turn without a restart or an invalidation to forget.
 */

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ConnectorMode } from "$lib/types/McpConnector";
import { CONNECTOR_MODES } from "$lib/types/McpConnector";
import type { McpServerConfig } from "./httpClient";
import { getMcpServers } from "./registry";

export const DEFAULT_MODE: ConnectorMode = "always";

export const baseKey = (name: string) => `base:${name}`;
export const connectorKey = (id: string) => `connector:${id}`;

export function isConnectorMode(value: unknown): value is ConnectorMode {
	return typeof value === "string" && (CONNECTOR_MODES as readonly string[]).includes(value);
}

/** Every stored mode, by key. A key that is not here is `always`. */
export async function loadModes(): Promise<Map<string, ConnectorMode>> {
	try {
		const rows = await collections.connectorModes.find({}).toArray();
		return new Map(rows.filter((r) => isConnectorMode(r.mode)).map((r) => [r.key, r.mode]));
	} catch (err) {
		// A mode that cannot be read must not become "offer nothing" or "offer
		// everything" by accident; the default is the documented one.
		logger.warn({ err: String(err) }, "connector_modes_unreadable");
		return new Map();
	}
}

export function modeIn(modes: Map<string, ConnectorMode>, key: string): ConnectorMode {
	return modes.get(key) ?? DEFAULT_MODE;
}

/** Store a mode. `always` removes the row, because it is the default. */
export async function setMode(key: string, mode: ConnectorMode): Promise<void> {
	if (mode === DEFAULT_MODE) {
		await collections.connectorModes.deleteOne({ key });
		return;
	}
	const now = new Date();
	await collections.connectorModes.updateOne(
		{ key },
		{ $set: { mode, updatedAt: now }, $setOnInsert: { createdAt: now } },
		{ upsert: true }
	);
}

export async function clearMode(key: string): Promise<void> {
	await collections.connectorModes.deleteOne({ key });
}

/**
 * The `.env` servers a turn may use.
 *
 * `selectedNames` is what the person switched on (the names the browser sent);
 * `undefined` means no selection exists, so only the always-on servers apply.
 * `off` never passes. Pass `"any"` where the call was already approved in a
 * turn that had its own selection (a resume): everything but `off` may be
 * called.
 */
export async function envServersFor(
	selectedNames: readonly string[] | undefined | "any",
	modes?: Map<string, ConnectorMode>
): Promise<McpServerConfig[]> {
	const all = modes ?? (await loadModes());
	return getMcpServers().filter((server) => {
		const mode = modeIn(all, baseKey(server.name));
		if (mode === "off") return false;
		if (mode === "always") return true;
		return selectedNames === "any" || (selectedNames?.includes(server.name) ?? false);
	});
}

/** The names of the `.env` servers that are on for everyone. */
export async function alwaysEnvNames(modes?: Map<string, ConnectorMode>): Promise<Set<string>> {
	const all = modes ?? (await loadModes());
	return new Set(
		getMcpServers()
			.filter((s) => modeIn(all, baseKey(s.name)) === "always")
			.map((s) => s.name)
	);
}

/**
 * What a turn's connector ids become: the person's own and their machines'
 * pass through; a deployment connector is added when `always`, kept only when
 * `optional`, and dropped when `off`, whatever was sent.
 */
export async function effectiveConnectorIds(
	sent: readonly string[],
	modes?: Map<string, ConnectorMode>
): Promise<{ ids: string[]; always: string[] }> {
	const all = modes ?? (await loadModes());
	const deployment = await collections.mcpConnectors
		.find({ scope: "deployment" }, { projection: { _id: 1 } })
		.toArray();
	const modeById = new Map(
		deployment.map((c) => [c._id.toString(), modeIn(all, connectorKey(c._id.toString()))])
	);
	const kept = sent.filter((id) => {
		const mode = modeById.get(id);
		return mode === undefined || mode === "optional";
	});
	const always = [...modeById].filter(([, mode]) => mode === "always").map(([id]) => id);
	return { ids: [...new Set([...kept, ...always])], always };
}
