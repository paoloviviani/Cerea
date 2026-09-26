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
 * What *is* kept locally is the selection, in two halves. Settings hold
 * *defaults* (`defaultConnectorIds`, for new chats, edited only in the
 * Workspace MCP tab); a chat holds *per-chat state* (`selectedConnectorIds`,
 * the active conversation's set, edited by the composer badge and pickers).
 * New chats inherit the defaults, and nothing done inside a chat ever writes
 * back to them. An id is not a capability — the server re-checks ownership
 * and looks the token up by `(userId, connectorId)` on every request — so
 * both halves are preferences, and they belong next to the other one.
 */

import { writable, derived, get } from "svelte/store";
import { base } from "$app/paths";
import { browser } from "$app/environment";
import { enabledServersCount } from "$lib/stores/mcpServers";
import type { McpConnectorView } from "$lib/types/McpConnector";

export const LEGACY_STORAGE_KEY = "pystino:mcp:selected-connector-ids";
export const DEFAULT_STORAGE_KEY = "pystino:mcp:default-connector-ids";
/** Storage key for the per-conversation selections (page state, not defaults). */
export const CONVERSATION_STORAGE_PREFIX = "pystino:mcp:conversation-connector-ids:";

function readIds(key: string): Set<string> | null {
	if (!browser) return null;
	try {
		const json = localStorage.getItem(key);
		if (json === null) return null;
		return new Set<string>(JSON.parse(json));
	} catch (error) {
		console.error("Failed to load connector IDs:", error);
		return null;
	}
}

/**
 * Seed the new defaults key from the existing selected set once, so nobody's
 * current setup silently changes on upgrade. Runs on load and is exported
 * for tests: when the defaults key is absent but the legacy key is present,
 * the legacy set becomes the defaults.
 */
export function migrateConnectorDefaults(): void {
	if (!browser) return;
	try {
		if (localStorage.getItem(DEFAULT_STORAGE_KEY) !== null) return;
		const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
		const seeded: string[] = legacy ? (JSON.parse(legacy) as string[]) : [];
		localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify(seeded));
	} catch (error) {
		console.error("Failed to migrate connector defaults:", error);
	}
}

function loadDefaults(): Set<string> {
	if (!browser) return new Set();
	migrateConnectorDefaults();
	return readIds(DEFAULT_STORAGE_KEY) ?? new Set<string>();
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
/**
 * The default selection for NEW chats, edited ONLY in the Workspace MCP tab.
 * Persisted under a new key; seeded once from the legacy selected set.
 */
export const defaultConnectorIds = writable<Set<string>>(loadDefaults());

if (browser) {
	defaultConnectorIds.subscribe((ids) => {
		try {
			localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify([...ids]));
		} catch (error) {
			console.error("Failed to save default connector IDs:", error);
		}
	});
}

/**
 * The ACTIVE chat's selection: page/component state, initialized from the
 * defaults (or the project defaults, when in a project) when a chat is
 * created or first opened, then fully independent. The composer badge, the
 * chat pickers and the request body all read this — never the defaults — so
 * disabling an MCP inside a chat poisons nothing for the next chats.
 *
 * Keyed per conversation so two open chats never share a set; `null` is the
 * not-yet-created chat on the home page. Persisted per conversation in
 * localStorage (unlike the old single global), so reopening a chat finds its
 * own selection, while a chat never opened inherits the defaults.
 */
const conversationSelections = new Map<string, Set<string>>();
/** Which conversation the active selection belongs to; `null` is the new-chat page. */
let activeConversationKey: string | null = null;

function conversationKey(convId: string | null): string {
	return convId ?? "__new__";
}

function writeActiveSelection(key: string, ids: Set<string>): void {
	if (!browser) return;
	try {
		localStorage.setItem(CONVERSATION_STORAGE_PREFIX + key, JSON.stringify([...ids]));
	} catch (error) {
		console.error("Failed to save conversation connector IDs:", error);
	}
}

function readActiveSelection(key: string): Set<string> | null {
	return readIds(CONVERSATION_STORAGE_PREFIX + key);
}

export const selectedConnectorIds = writable<Set<string>>(new Set());

/** True once a conversation has been opened: before that the active set is unowned. */
let selectionReady = false;

if (browser) {
	selectedConnectorIds.subscribe((ids) => {
		if (!selectionReady) return;
		const key = conversationKey(activeConversationKey);
		conversationSelections.set(key, new Set(ids));
		writeActiveSelection(key, ids);
	});
}

/**
 * Make the selection for `convId` active, initializing it once from `seed`
 * (project defaults, else workspace defaults) when the chat is first opened.
 * The active set is then fully independent: later default changes never
 * rewrite it, and its own edits never write back to the defaults.
 *
 * The `null` (not-yet-created) chat is the exception: it has no independent
 * state worth preserving across opens — the home-page draft does not survive
 * navigation and `onMount` runs once per mount — so it re-seeds from
 * `seed ?? get(defaultConnectorIds)` on every open, keeping the home comment
 * ("starts at the workspace defaults; the first toggle then diverges") true
 * within a mount.
 */
export function openConversationSelection(convId: string | null, seed?: Iterable<string>): void {
	const key = conversationKey(convId);
	activeConversationKey = convId;
	if (convId === null) {
		conversationSelections.set(key, new Set<string>(seed ?? get(defaultConnectorIds)));
	} else if (!conversationSelections.has(key)) {
		const stored = readActiveSelection(key);
		conversationSelections.set(key, stored ?? new Set<string>(seed ?? get(defaultConnectorIds)));
	}
	selectionReady = true;
	selectedConnectorIds.set(new Set(conversationSelections.get(key)));
}

/**
 * Hand the new-chat page's selection to the conversation it just created.
 *
 * The home composer edits the `null` chat's set; the conversation page then
 * opens under a real id it has never seen and would seed it from the
 * defaults — so a connector switched on for the first message was dropped
 * from that very message. Called before navigating, it makes the first open
 * of the new id find the set the person actually chose.
 */
export function adoptNewChatSelection(convId: string): void {
	const ids = new Set(
		conversationSelections.get(conversationKey(null)) ?? get(selectedConnectorIds)
	);
	conversationSelections.set(conversationKey(convId), ids);
	writeActiveSelection(conversationKey(convId), ids);
}

/** Forget cached per-conversation state (tests sign out between cases). */
export function resetConversationSelections(): void {
	conversationSelections.clear();
	activeConversationKey = null;
	selectionReady = false;
	selectedConnectorIds.set(new Set());
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

/**
 * The defaults as they would actually send: same `connected`-filtering as
 * `enabledConnectors`, which stays exactly as is. For the Workspace MCP tab,
 * which edits and counts defaults rather than the active chat.
 */
export const defaultEnabledConnectors = derived(
	[connectors, defaultConnectorIds],
	([$all, $defaults]) => $all.filter((c) => c.connected && $defaults.has(c.id))
);

export const defaultEnabledConnectorsCount = derived(defaultEnabledConnectors, ($on) => $on.length);

export async function refreshConnectors(): Promise<void> {
	try {
		const response = await fetch(`${base}/api/v2/mcp/connectors`);
		if (!response.ok) throw new Error(`status ${response.status}`);
		const { data } = (await response.json()) as { data: McpConnectorView[] };
		connectors.set(data);
		connectorsFailed.set(false);

		// Forget a selection whose connector is gone, so removing one does not
		// leave an id that the server would only refuse. Both the defaults
		// and every cached per-conversation set: a removed connector refuses
		// whoever names it.
		const live = new Set(data.map((c) => c.id));
		defaultConnectorIds.update(($ids) => new Set([...$ids].filter((id) => live.has(id))));
		for (const [key, ids] of conversationSelections) {
			conversationSelections.set(key, new Set([...ids].filter((id) => live.has(id))));
		}
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

/** What the Workspace MCP tab's header should say: base servers plus connector defaults. */
export const totalDefaultMcpCount = derived(
	[enabledServersCount, defaultEnabledConnectorsCount],
	([$servers, $connectors]) => $servers + $connectors
);

/**
 * Flip one connector in the ACTIVE chat's selection. Per-chat state: the
 * defaults never move. This is what the composer badge and the chat pickers
 * call.
 */
export function toggleConnector(id: string): void {
	selectedConnectorIds.update(($ids) => {
		const next = new Set($ids);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	});
}

/**
 * Turn every connector off in the ACTIVE chat.
 *
 * The selection only; the connectors and their sign-ins stay. This is the
 * composer's "no tools on this message" button, not a disconnect — going
 * through the consent screen again to ask one question without Notion would be
 * an absurd price for a wrong click. Per-chat state: the defaults never move.
 */
export function disableAllConnectors(): void {
	selectedConnectorIds.set(new Set());
}

/**
 * Flip one connector in the DEFAULTS for new chats. The Workspace MCP tab —
 * and only it — calls this.
 */
export function toggleDefaultConnector(id: string): void {
	defaultConnectorIds.update(($ids) => {
		const next = new Set($ids);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		return next;
	});
}

/** Replace the whole defaults set (the workspace tab's bulk edits). */
export function setDefaultConnectors(ids: Iterable<string>): void {
	defaultConnectorIds.set(new Set(ids));
}

/** Turn a default on (a sign-in from the workspace tab means it for new chats too). */
export function selectDefaultConnector(id: string): void {
	if (get(defaultConnectorIds).has(id)) return;
	defaultConnectorIds.update(($ids) => new Set([...$ids, id]));
}

/**
 * Turn a connector on in the ACTIVE chat because somebody just signed in to
 * it. Per-chat state: the workspace tab's sign-in path calls
 * `selectDefaultConnector` instead.
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
			// Carried over as it was: a server that was on stays on, in the
			// active chat and in the defaults for new chats alike.
			selectConnector(created.id);
			selectDefaultConnector(created.id);
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
