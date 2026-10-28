/**
 * What each connector offers, kept so a turn can list its connectors without
 * contacting them (ADR 0104).
 *
 * The assistant sees one line per connector it can load: the name, a sentence,
 * and the tool names. Building that line for a turn must not open a connection
 * to every enabled connector, so it reads from here:
 *
 * - the `.env` servers have no database row, so this is their cache. It is
 *   filled on boot and refreshed on a timer, and only by that refresh, which
 *   lists each server with no person's credential: a listing a turn makes with
 *   somebody's token never lands here, so it never reaches anybody else's list.
 *   Between refreshes an entry does not change, so a server's line is the same
 *   from one turn to the next;
 * - an administrator's or a person's own connector uses the tool names stored
 *   on its row by its last check, never this cache.
 *
 * Keyed by the server's configured address.
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

let refreshing = false;

/**
 * List the given `.env` servers once, so their entries are filled. Each is listed as a turn
 * would call it (`callableServers`: URL safety and the deployment's own overlays) but with no
 * person's token, and recorded under its configured address. A failure leaves the old entry.
 * A refresh that is still running is not started again.
 */
export async function refreshCatalog(servers: McpServerConfig[]): Promise<void> {
	if (refreshing) return;
	refreshing = true;
	try {
		const { getOpenAiToolsForMcp } = await import("./tools");
		const { callableServers } = await import("./serverOverlays");
		await Promise.all(
			servers.map(async (server) => {
				const [callable] = callableServers([server]);
				if (!callable) return;
				try {
					const { tools, unavailable } = await getOpenAiToolsForMcp([callable], {
						ttlMs: 0,
						markUntrusted: false,
					});
					if (unavailable?.length) return;
					rememberTools(
						server.url,
						tools.map((tool) => ({
							name: tool.function.name,
							description: tool.function.description,
						}))
					);
				} catch (err) {
					logger.info({ server: server.name, err: String(err) }, "[mcp] catalogue refresh failed");
				}
			})
		);
	} finally {
		refreshing = false;
	}
}

/**
 * Fill the `.env` servers' entries now and again every quarter of an hour. `list` gives the
 * servers to poll each time: the ones the deployment offers (not Off), read afresh.
 */
export function startCatalogRefresh(list: () => Promise<McpServerConfig[]>): void {
	const run = () =>
		list()
			.then(refreshCatalog)
			.catch((err) => logger.info({ err: String(err) }, "[mcp] catalogue refresh skipped"));
	void run();
	if (timer) return;
	timer = setInterval(() => void run(), REFRESH_MS);
	timer.unref?.();
}
