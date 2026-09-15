/**
 * Which connectors this person has, and which are on for the next message
 * (ADR 0064).
 *
 * Deliberately a thin store beside `mcpServers.ts` rather than part of it. A
 * custom server in there is *defined* in localStorage — its URL and its
 * `Authorization` header live in the browser — and a connector is defined on
 * the server, where its credential is. Merging them would mean one collection
 * with two truths about where a secret lives, and the shape that keeps them
 * apart is what makes "the credential never reaches the browser" checkable.
 *
 * What *is* kept locally is the selection: a set of connector ids. An id is
 * not a capability — the server re-checks ownership and looks the token up by
 * `(userId, connectorId)` on every request — so this is a preference, and it
 * belongs next to the other one.
 */

import { writable, derived, get } from "svelte/store";
import { base } from "$app/paths";
import { browser } from "$app/environment";
import { enabledServersCount } from "$lib/stores/mcpServers";
import type { McpConnectorView } from "$lib/types/McpConnector";

const STORAGE_KEY = "pystino:mcp:selected-connector-ids";

function loadSelected(): Set<string> {
	if (!browser) return new Set();
	try {
		const json = localStorage.getItem(STORAGE_KEY);
		return new Set<string>(json ? JSON.parse(json) : []);
	} catch (error) {
		console.error("Failed to load selected connector IDs:", error);
		return new Set();
	}
}

export const connectors = writable<McpConnectorView[]>([]);
export const connectorsLoaded = writable(false);
/**
 * Whether the last load failed, so a picker can say so rather than
 * pretending there is nothing. Reset on every attempt; a signed-out
 * visitor's 401 lands here too, and callers that must degrade silently
 * (the composer's badge) simply ignore it.
 */
export const connectorsFailed = writable(false);
export const selectedConnectorIds = writable<Set<string>>(loadSelected());

if (browser) {
	selectedConnectorIds.subscribe((ids) => {
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
		} catch (error) {
			console.error("Failed to save selected connector IDs:", error);
		}
	});
}

/**
 * The ones that will actually be sent.
 *
 * Filtered on `connected`, because an unauthorised connector contributes no
 * tools and would fail the handshake mid-generation — a message that dies
 * halfway is a worse answer than a connector that is visibly off.
 */
export const enabledConnectors = derived([connectors, selectedConnectorIds], ([$all, $selected]) =>
	$all.filter((c) => c.connected && $selected.has(c.id))
);

export const enabledConnectorsCount = derived(enabledConnectors, ($on) => $on.length);

export async function refreshConnectors(): Promise<void> {
	try {
		const response = await fetch(`${base}/api/v2/mcp/connectors`);
		if (!response.ok) throw new Error(`status ${response.status}`);
		const { data } = (await response.json()) as { data: McpConnectorView[] };
		connectors.set(data);
		connectorsFailed.set(false);

		// Forget a selection whose connector is gone, so removing one does not
		// leave an id that the server would only refuse.
		const live = new Set(data.map((c) => c.id));
		selectedConnectorIds.update(($ids) => new Set([...$ids].filter((id) => live.has(id))));
	} catch (error) {
		console.error("Failed to load MCP connectors:", error);
		connectors.set([]);
		connectorsFailed.set(true);
	} finally {
		connectorsLoaded.set(true);
	}
}

/**
 * What the composer's MCP badge should say.
 *
 * Both kinds in one number, because the badge answers "how many tools is this
 * message carrying" and the person reading it does not care which half of the
 * dialog a tool came from.
 */
export const totalEnabledMcpCount = derived(
	[enabledServersCount, enabledConnectorsCount],
	([$servers, $connectors]) => $servers + $connectors
);

export function toggleConnector(id: string): void {
	selectedConnectorIds.update(($ids) => {
		const next = new Set($ids);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	});
}

/**
 * Turn every connector off.
 *
 * The selection only; the connectors and their sign-ins stay. This is the
 * composer's "no tools on this message" button, not a disconnect — going
 * through the consent screen again to ask one question without Notion would be
 * an absurd price for a wrong click.
 */
export function disableAllConnectors(): void {
	selectedConnectorIds.set(new Set());
}

/**
 * Turn a connector on because somebody just signed in to it.
 *
 * Signing in is the whole intent; leaving it off afterwards would make the
 * consent screen feel like it did nothing.
 */
export function selectConnector(id: string): void {
	if (get(selectedConnectorIds).has(id)) return;
	selectedConnectorIds.update(($ids) => new Set([...$ids, id]));
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
			// Carried over as it was: a server that was on stays on.
			selectConnector(created.id);
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
		throw new Error(parsed?.message ?? `The request failed (${response.status}).`);
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
