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

		// Forget a selection whose connector is gone, so removing one does not
		// leave an id that the server would only refuse.
		const live = new Set(data.map((c) => c.id));
		selectedConnectorIds.update(($ids) => new Set([...$ids].filter((id) => live.has(id))));
	} catch (error) {
		console.error("Failed to load MCP connectors:", error);
		connectors.set([]);
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

// Loaded on import rather than when the dialog opens, because the composer's
// badge has to be right before anybody opens anything. A signed-out visitor
// gets a 401, which `refreshConnectors` treats as "none" — the same answer, and
// not worth a special case.
if (browser) {
	void refreshConnectors();
}
