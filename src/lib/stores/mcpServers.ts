/**
 * MCP Servers Store
 * Manages base (env-configured) MCP servers. User-added custom servers were
 * the half this store used to carry; they are gone (ADR 0064 — connectors
 * are how a person brings their own server), and what remains of the split
 * is the selection and disable state for the deployment's base list.
 */

import { writable, derived, get } from "svelte/store";
import { base } from "$app/paths";
import { env as publicEnv } from "$env/dynamic/public";
import { browser } from "$app/environment";
import type { MCPServer, ServerStatus, MCPTool } from "$lib/types/Tool";

// Namespace storage by app identity to avoid collisions across apps
function toKeyPart(s: string | undefined): string {
	return (s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

const appLabel = toKeyPart(publicEnv.PUBLIC_APP_ASSETS || publicEnv.PUBLIC_APP_NAME);
const baseLabel = toKeyPart(typeof base === "string" ? base : "");
// Final prefix format requested: "huggingchat:key" (no mcp:/chat)
const KEY_PREFIX = appLabel || baseLabel || "app";

const STORAGE_KEYS = {
	SELECTED_IDS: `${KEY_PREFIX}:mcp:selected-ids`,
	DISABLED_BASE_IDS: `${KEY_PREFIX}:mcp:disabled-base-ids`,
} as const;

// Load selected server IDs from localStorage
function loadSelectedIds(): Set<string> {
	if (!browser) return new Set();

	try {
		const json = localStorage.getItem(STORAGE_KEYS.SELECTED_IDS);
		const ids: string[] = json ? JSON.parse(json) : [];
		return new Set(ids);
	} catch (error) {
		console.error("Failed to load selected MCP server IDs from localStorage:", error);
		return new Set();
	}
}

// Save selected IDs to localStorage
function saveSelectedIds(ids: Set<string>) {
	if (!browser) return;

	try {
		localStorage.setItem(STORAGE_KEYS.SELECTED_IDS, JSON.stringify([...ids]));
	} catch (error) {
		console.error("Failed to save selected MCP server IDs to localStorage:", error);
	}
}

// Load disabled base server IDs from localStorage (empty set if missing or on error)
function loadDisabledBaseIds(): Set<string> {
	if (!browser) return new Set();

	try {
		const json = localStorage.getItem(STORAGE_KEYS.DISABLED_BASE_IDS);
		return new Set(json ? JSON.parse(json) : []);
	} catch (error) {
		console.error("Failed to load disabled base MCP server IDs from localStorage:", error);
		return new Set();
	}
}

// Save disabled base server IDs to localStorage
function saveDisabledBaseIds(ids: Set<string>) {
	if (!browser) return;

	try {
		localStorage.setItem(STORAGE_KEYS.DISABLED_BASE_IDS, JSON.stringify([...ids]));
	} catch (error) {
		console.error("Failed to save disabled base MCP server IDs to localStorage:", error);
	}
}

// Store for base servers
export const allMcpServers = writable<MCPServer[]>([]);

// Track if initial server load has completed
export const mcpServersLoaded = writable<boolean>(false);

// Store for selected server IDs
export const selectedServerIds = writable<Set<string>>(loadSelectedIds());

// Auto-persist selected IDs when they change
if (browser) {
	selectedServerIds.subscribe((ids) => {
		saveSelectedIds(ids);
	});
}

// Derived store: only enabled servers
export const enabledServers = derived([allMcpServers, selectedServerIds], ([$all, $selected]) =>
	$all.filter((s) => $selected.has(s.id))
);

// Derived store: count of enabled servers
export const enabledServersCount = derived(enabledServers, ($enabled) => $enabled.length);

// Derived store: true if all base servers are enabled
export const allBaseServersEnabled = derived(
	[allMcpServers, selectedServerIds],
	([$all, $selected]) => {
		const baseServers = $all.filter((s) => s.type === "base");
		return baseServers.length > 0 && baseServers.every((s) => $selected.has(s.id));
	}
);

// Note: Authorization overlay (with user's HF token) for the Hugging Face MCP host
// is applied server-side when enabled via MCP_FORWARD_HF_USER_TOKEN.

/**
 * Populate the MCP store from a known base-server list without making a network
 * request. Applies the user's disabled-server preferences and sets
 * mcpServersLoaded synchronously.
 *
 * Called from the root layout script block with the server list that arrived in
 * the SSR payload, so the store is ready before any child onMount fires.
 * The background refreshMcpServers() call still runs to pick up status changes.
 */
export function initWithServers(baseServers: MCPServer[]): void {
	allMcpServers.set(baseServers);

	// Load disabled base servers
	const disabledBaseIds = loadDisabledBaseIds();

	// Auto-enable all base servers that aren't explicitly disabled.
	selectedServerIds.update(() => {
		const newSelection = new Set<string>();

		for (const server of baseServers) {
			if (!disabledBaseIds.has(server.id)) {
				newSelection.add(server.id);
			}
		}

		return newSelection;
	});
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
 * Toggle a server on/off
 */
export function toggleServer(id: string) {
	selectedServerIds.update(($ids) => {
		const newSet = new Set($ids);
		if (newSet.has(id)) {
			newSet.delete(id);
			// Track if this is a base server being disabled
			if (id.startsWith("base-")) {
				const disabled = loadDisabledBaseIds();
				disabled.add(id);
				saveDisabledBaseIds(disabled);
			}
		} else {
			newSet.add(id);
			// Remove from disabled if re-enabling a base server
			if (id.startsWith("base-")) {
				const disabled = loadDisabledBaseIds();
				disabled.delete(id);
				saveDisabledBaseIds(disabled);
			}
		}
		return newSet;
	});
}

/**
 * Disable all MCP servers (marks all base servers as disabled)
 */
export function disableAllServers() {
	// Get current base server IDs and mark them all as disabled
	const servers = get(allMcpServers);
	const baseServerIds = servers.filter((s) => s.type === "base").map((s) => s.id);

	// Save all base servers as disabled
	saveDisabledBaseIds(new Set(baseServerIds));

	// Clear the selection
	selectedServerIds.set(new Set());
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
		const errorMessage = error instanceof Error ? error.message : "Unknown error";
		updateServerStatus(server.id, "error", errorMessage);
		return { ready: false, error: errorMessage };
	}
}

// Initialize on module load
if (browser) {
	refreshMcpServers();
}
