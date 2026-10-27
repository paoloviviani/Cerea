/**
 * What each connector offers, kept so a turn can list its connectors without
 * contacting them (ADR 0104).
 *
 * The assistant sees one line per connector it can load: the name, a sentence,
 * and the tool names. Building that line for a turn must not open a connection
 * to every enabled connector, so it reads from here:
 *
 * - the `.env` servers have no database row, so this is their cache. It is
 *   filled on boot and refreshed on a timer, and every real tool listing
 *   (a connector being loaded) refreshes its entry too;
 * - an administrator's or a person's own connector also stores its tool names
 *   from its last check on its row, which is the fallback here.
 *
 * Keyed by address. The tool names of an address are not a credential, and one
 * connector's entry never stands in for another's.
 */

import { logger } from "$lib/server/logger";
import type { McpServerConfig } from "./httpClient";

export interface CatalogTool {
	name: string;
	description?: string;
}

const REFRESH_MS = 15 * 60_000;
const known = new Map<string, { tools: CatalogTool[]; at: number }>();
let timer: ReturnType<typeof setInterval> | undefined;

export function rememberTools(url: string, tools: CatalogTool[]): void {
	known.set(url, {
		tools: tools.map(({ name, description }) => ({ name, description })),
		at: Date.now(),
	});
}

export function knownTools(url: string): CatalogTool[] | undefined {
	return known.get(url)?.tools;
}

export function resetCatalogCache(): void {
	known.clear();
}

/** List the given servers once, so their entries are filled. A failure leaves the old entry. */
export async function refreshCatalog(servers: McpServerConfig[]): Promise<void> {
	const { getOpenAiToolsForMcp } = await import("./tools");
	await Promise.all(
		servers.map(async (server) => {
			try {
				// Listing records into this cache as a side effect.
				await getOpenAiToolsForMcp([server], { ttlMs: 0 });
			} catch (err) {
				logger.info({ server: server.name, err: String(err) }, "[mcp] catalogue refresh failed");
			}
		})
	);
}

/** Fill the `.env` servers' entries now and again every quarter of an hour. */
export function startCatalogRefresh(list: () => McpServerConfig[]): void {
	void refreshCatalog(list());
	if (timer) return;
	timer = setInterval(() => void refreshCatalog(list()), REFRESH_MS);
	timer.unref?.();
}
