import { m } from "$lib/paraglide/messages";
/**
 * The deployment's `.env` servers, as Workspace shows them (ADR 0104).
 *
 * Each arrives with how the deployment offers it (`on`, or `locked` when a
 * person cannot switch it off) and whether this person has it on. The server
 * decides what a turn uses from its own records; this store only shows them
 * and carries the status of the health checks. Nothing here is a selection:
 * the browser keeps no choice of its own, and the old localStorage keys
 * (`mcp:selected-ids`, `mcp:disabled-base-ids`) are forgotten, not read.
 */

import { writable } from "svelte/store";
import { base } from "$app/paths";
import { browser } from "$app/environment";
import type { MCPServer, ServerStatus, MCPTool } from "$lib/types/Tool";

// Store for base servers
export const allMcpServers = writable<MCPServer[]>([]);

// Track if initial server load has completed
export const mcpServersLoaded = writable<boolean>(false);

/**
 * Forget what older builds kept in this browser about which servers were on:
 * the server owns that now, and a stale copy must never look like a choice.
 */
export function forgetOldMcpSelections(): void {
	if (!browser) return;
	try {
		const stale: string[] = [];
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (
				key &&
				(key.endsWith(":mcp:selected-ids") ||
					key.endsWith(":mcp:disabled-base-ids") ||
					key.startsWith("pystino:mcp:conversation-connector-ids:") ||
					key === "pystino:mcp:selected-connector-ids" ||
					key === "pystino:mcp:default-connector-ids")
			) {
				stale.push(key);
			}
		}
		for (const key of stale) localStorage.removeItem(key);
	} catch {
		// A browser that will not let us look leaves nothing that is read anyway.
	}
}

/** Set the store from a known server list without a request (the SSR payload, tests). */
export function initWithServers(servers: MCPServer[]): void {
	allMcpServers.set(servers);
	mcpServersLoaded.set(true);
}

/**
 * Refresh base servers from API
 */
export async function refreshMcpServers() {
	try {
		const response = await fetch(`${base}/api/mcp/servers`);
		if (!response.ok) {
			throw new Error(`Failed to fetch base servers: ${response.statusText}`);
		}

		const baseServers: MCPServer[] = await response.json();
		initWithServers(baseServers);
	} catch (error) {
		console.error("Failed to refresh MCP servers:", error);
		// On error, keep whatever is in the store rather than blanking it: a
		// failed refresh is a stale list, which is the useful half of the truth.
		mcpServersLoaded.set(true);
	}
}

/**
 * Update server status (from health check)
 */
export function updateServerStatus(
	id: string,
	status: ServerStatus,
	errorMessage?: string,
	tools?: MCPTool[],
	authRequired?: boolean
) {
	allMcpServers.update(($servers) =>
		$servers.map((s) =>
			s.id === id
				? {
						...s,
						status,
						errorMessage,
						tools,
						authRequired,
					}
				: s
		)
	);
}

/**
 * Run health check on a server
 */
export async function healthCheckServer(
	server: MCPServer
): Promise<{ ready: boolean; tools?: MCPTool[]; error?: string }> {
	try {
		updateServerStatus(server.id, "connecting");

		const response = await fetch(`${base}/api/mcp/health`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: server.url, headers: server.headers }),
		});

		const result = await response.json();

		if (result.ready && result.tools) {
			updateServerStatus(server.id, "connected", undefined, result.tools, false);
			return { ready: true, tools: result.tools };
		} else {
			updateServerStatus(server.id, "error", result.error, undefined, Boolean(result.authRequired));
			return { ready: false, error: result.error };
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : m["chat.errors.unknown"]();
		updateServerStatus(server.id, "error", errorMessage);
		return { ready: false, error: errorMessage };
	}
}

// Initialize on module load
if (browser) {
	forgetOldMcpSelections();
	refreshMcpServers();
}
