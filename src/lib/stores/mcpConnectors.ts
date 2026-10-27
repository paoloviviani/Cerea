import { m } from "$lib/paraglide/messages";
/**
 * Which connectors this person has, and which are on (ADR 0064, ADR 0104).
 *
 * A connector is *defined* on the server, where its credential is; so is
 * whether it is on. This store is a view of that list for Workspace, plus the
 * one action there is: switch one on or off. The browser keeps no selection of
 * its own and sends none with a message: a connector that is on is offered to
 * the assistant, which loads its tools when it needs them. (Older builds kept
 * per-chat selections in `localStorage`; `forgetOldMcpSelections` drops them.)
 */

import { writable, derived, get } from "svelte/store";
import { base } from "$app/paths";
import { browser } from "$app/environment";
import { allMcpServers } from "$lib/stores/mcpServers";
import type { McpConnectorView } from "$lib/types/McpConnector";

export const connectors = writable<McpConnectorView[]>([]);
export const connectorsLoaded = writable(false);
/**
 * Whether the last load failed, so a picker can say so rather than
 * pretending there is nothing. Reset on every attempt; a signed-out
 * visitor's 401 lands here too, and callers that must degrade silently
 * simply ignore it.
 */
export const connectorsFailed = writable(false);

/** Which refresh is the latest: an older one that answers after it must not
 * overwrite what it found. */
let refreshGeneration = 0;

export async function refreshConnectors(): Promise<void> {
	const generation = ++refreshGeneration;
	try {
		const response = await fetch(`${base}/api/v2/mcp/connectors`);
		if (!response.ok) throw new Error(`status ${response.status}`);
		const { data } = (await response.json()) as { data: McpConnectorView[] };
		if (generation !== refreshGeneration) return;
		connectors.set(data);
		connectorsFailed.set(false);
	} catch (error) {
		if (generation !== refreshGeneration) return;
		console.error("Failed to load MCP connectors:", error);
		connectors.set([]);
		connectorsFailed.set(true);
	} finally {
		if (generation === refreshGeneration) connectorsLoaded.set(true);
	}
}

/**
 * How many connectors are on for this person, and can be used: the `.env` servers
 * and connectors that are on, leaving out any that need a sign-in first.
 */
export const enabledConnectorsCount = derived([allMcpServers, connectors], ([$servers, $all]) => {
	return (
		$servers.filter((s) => s.enabled !== false).length +
		$all.filter((c) => c.enabled && c.connected).length
	);
});

/**
 * Switch one connector on or off for this person. Shown at once and put back if the server
 * refuses (a connector the deployment keeps on cannot be switched off). `key` is the
 * connector's `key`: `base:<name>`, `connector:<id>` or a machine's `local:` id.
 */
export async function setConnectorEnabled(key: string, enabled: boolean): Promise<void> {
	const before = { servers: get(allMcpServers), connectors: get(connectors) };
	allMcpServers.update(($s) => $s.map((s) => (s.key === key ? { ...s, enabled } : s)));
	connectors.update(($c) => $c.map((c) => (c.key === key ? { ...c, enabled } : c)));
	try {
		const response = await fetch(`${base}/api/v2/mcp/switches`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key, enabled }),
		});
		if (!response.ok) {
			const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
			throw new Error(
				parsed?.message ?? m["chat.errors.request_failed"]({ status: response.status })
			);
		}
	} catch (error) {
		allMcpServers.set(before.servers);
		connectors.set(before.connectors);
		throw error;
	}
}

/**
 * Move whatever the old UI left in `localStorage` to the server, once.
 *
 * Not optional and not a prompt. Those entries are the servers people are
 * actually using, and a release that silently dropped them would be
 * indistinguishable from data loss. The headers come across too — the sealed
 * server-side store is a strictly better home for them than the one they are
 * sitting in, which is the whole point of ADR 0064.
 *
 * Only the first credential-looking header migrates, because a connector holds
 * one credential. A server configured with two keeps its definition and is
 * logged, which is the honest outcome: better a connector somebody has to
 * finish than one quietly missing a header it needs.
 */
const CREDENTIAL_HEADERS = [
	"authorization",
	"x-api-key",
	"api-key",
	"apikey",
	"x-auth-token",
	"token",
];

/** Set once the localStorage servers have been moved server-side. */
const MIGRATED_KEY = "pystino:mcp:custom-servers-migrated";

interface StoredServer {
	name?: string;
	url?: string;
	headers?: { key: string; value: string }[];
}

export async function migrateCustomServers(): Promise<number> {
	if (!browser) return 0;

	let stored: StoredServer[] = [];
	try {
		if (localStorage.getItem(MIGRATED_KEY)) return 0;
		// The old key was namespaced by app identity, so read every spelling of
		// it rather than reconstructing the one this build would have used.
		for (let i = 0; i < localStorage.length; i++) {
			const key = localStorage.key(i);
			if (!key?.endsWith(":mcp:custom-servers")) continue;
			const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
			if (Array.isArray(parsed)) stored.push(...parsed);
		}
	} catch (error) {
		// Not marked as migrated: a browser that could not be read today may be
		// readable next time, and giving up silently is how the data is lost.
		console.error("Could not read the old custom servers:", error);
		return 0;
	}

	stored = stored.filter((s) => typeof s?.url === "string" && s.url.startsWith("https://"));
	if (stored.length === 0) {
		markMigrated();
		return 0;
	}

	const existing = new Set(get(connectors).map((c) => c.url));
	let moved = 0;

	for (const server of stored) {
		if (!server.url || existing.has(server.url)) continue;
		const headers = server.headers?.filter((h) => h?.key && h?.value) ?? [];
		const credential = headers.find((h) => CREDENTIAL_HEADERS.includes(h.key.toLowerCase()));
		const extras = headers.filter((h) => h !== credential);

		try {
			const created = await addConnector({
				name: server.name?.trim() || new URL(server.url).hostname,
				url: server.url,
				...(credential
					? {
							authMode: "token" as const,
							// The value as stored, minus the scheme the header
							// carries separately — a migrated `Bearer abc` must not
							// become `Bearer Bearer abc`.
							token: credential.value.replace(/^Bearer\s+/i, ""),
							tokenHeader: credential.key,
							tokenPrefix: /^authorization$/i.test(credential.key) ? "Bearer " : "",
						}
					: { authMode: "auto" as const }),
			});
			moved++;
			// A new connector is on for its owner (ADR 0104), which is what "stays on" meant here.
			if (extras.length > 0) {
				console.warn(
					`[mcp] "${created.name}" had extra headers that were not migrated:`,
					extras.map((h) => h.key)
				);
			}
		} catch (error) {
			console.error(`[mcp] could not migrate "${server.name ?? server.url}":`, error);
		}
	}

	markMigrated();
	return moved;
}

function markMigrated() {
	try {
		localStorage.setItem(MIGRATED_KEY, new Date().toISOString());
	} catch {
		// A browser refusing to remember this will simply look again, which is
		// harmless: the URL check above skips what is already a connector.
	}
}

export interface NewConnector {
	name: string;
	url: string;
	authMode?: "auto" | "none" | "token" | "oauth" | "oauth_static";
	token?: string;
	tokenHeader?: string;
	tokenPrefix?: string;
}

export async function addConnector(input: NewConnector): Promise<McpConnectorView> {
	const response = await fetch(`${base}/api/v2/mcp/connectors`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) {
		const parsed = (await response.json().catch(() => null)) as { message?: string } | null;
		throw new Error(
			parsed?.message ?? m["chat.errors.request_failed"]({ status: response.status })
		);
	}
	const created = (await response.json()) as McpConnectorView;
	await refreshConnectors();
	return created;
}

// Loaded on import rather than when the dialog opens, because the composer's
// badge has to be right before anybody opens anything. A signed-out visitor
// gets a 401, which `refreshConnectors` treats as "none" — the same answer, and
// not worth a special case.
if (browser) {
	void refreshConnectors().then(() => migrateCustomServers());
}
