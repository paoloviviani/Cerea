/**
 * MCP defaults-vs-state.
 *
 * Settings hold *defaults* (`defaultConnectorIds`, edited only in the
 * Workspace MCP tab); a chat holds *per-chat state* (the active selection,
 * edited by the composer badge and pickers). New chats inherit the defaults,
 * and nothing done inside a chat ever writes back to them.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "svelte/store";
import {
	LEGACY_STORAGE_KEY,
	DEFAULT_STORAGE_KEY,
	CONVERSATION_STORAGE_PREFIX,
	defaultConnectorIds,
	selectedConnectorIds,
	toggleConnector,
	toggleDefaultConnector,
	disableAllConnectors,
	openConversationSelection,
	adoptNewChatSelection,
	resetConversationSelections,
	migrateConnectorDefaults,
} from "./mcpConnectors";

// The stores read `$env/dynamic/public` at module scope (via mcpServers);
// the client project runs in a real browser where no SvelteKit env exists.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

function conversationKey(convId: string | null): string {
	return `${CONVERSATION_STORAGE_PREFIX}${convId ?? "__new__"}`;
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 }))
	);
	localStorage.clear();
	resetConversationSelections();
	defaultConnectorIds.set(new Set());
});

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

describe("connector defaults migration", () => {
	it("seeds the new defaults key from the legacy selected set once", () => {
		localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(["conn-a", "conn-b"]));
		localStorage.removeItem(DEFAULT_STORAGE_KEY);

		migrateConnectorDefaults();

		expect(JSON.parse(localStorage.getItem(DEFAULT_STORAGE_KEY) ?? "")).toEqual([
			"conn-a",
			"conn-b",
		]);
	});

	it("never overwrites defaults once they exist", () => {
		localStorage.setItem(DEFAULT_STORAGE_KEY, JSON.stringify(["conn-keep"]));
		localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(["conn-other"]));

		migrateConnectorDefaults();

		expect(JSON.parse(localStorage.getItem(DEFAULT_STORAGE_KEY) ?? "")).toEqual(["conn-keep"]);
	});

	it("seeds empty defaults when there was no legacy selection", () => {
		localStorage.removeItem(DEFAULT_STORAGE_KEY);
		localStorage.removeItem(LEGACY_STORAGE_KEY);

		migrateConnectorDefaults();

		expect(JSON.parse(localStorage.getItem(DEFAULT_STORAGE_KEY) ?? "")).toEqual([]);
	});
});

describe("defaults vs per-chat selection", () => {
	it("a new chat inherits the defaults", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));

		openConversationSelection("chat-new", get(defaultConnectorIds));

		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-a"]));
	});

	it("toggling in one chat does not change the defaults or other chats", () => {
		defaultConnectorIds.set(new Set(["conn-a", "conn-b"]));

		// Chat A opens and turns one connector off.
		openConversationSelection("chat-a", get(defaultConnectorIds));
		toggleConnector("conn-a");

		// The defaults never moved…
		expect(get(defaultConnectorIds)).toEqual(new Set(["conn-a", "conn-b"]));
		expect(JSON.parse(localStorage.getItem(DEFAULT_STORAGE_KEY) ?? "")).toEqual([
			"conn-a",
			"conn-b",
		]);

		// …and chat B still inherits the untouched defaults.
		openConversationSelection("chat-b", get(defaultConnectorIds));
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-a", "conn-b"]));

		// Chat A's own edit survived the switch away and back.
		openConversationSelection("chat-a");
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-b"]));
	});

	it("disable-all in a chat leaves the defaults on", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection("chat-a", get(defaultConnectorIds));

		disableAllConnectors();

		expect(get(selectedConnectorIds)).toEqual(new Set());
		expect(get(defaultConnectorIds)).toEqual(new Set(["conn-a"]));
	});

	it("editing the defaults never rewrites the active chat", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection("chat-a", get(defaultConnectorIds));

		toggleDefaultConnector("conn-b");

		expect(get(defaultConnectorIds)).toEqual(new Set(["conn-a", "conn-b"]));
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-a"]));
	});

	it("reopening a chat finds its own selection, not the current defaults", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection("chat-a", get(defaultConnectorIds));
		toggleConnector("conn-b");

		// Defaults change underneath (workspace tab, another tab, a new login).
		defaultConnectorIds.set(new Set(["conn-z"]));

		openConversationSelection("chat-b", get(defaultConnectorIds));
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-z"]));

		openConversationSelection("chat-a");
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-a", "conn-b"]));
		expect(localStorage.getItem(conversationKey("chat-a"))).toContain("conn-b");
	});

	it("a subsequently opened new chat starts from the current defaults in both directions", () => {
		// First visit seeds the new-chat selection empty.
		openConversationSelection(null, get(defaultConnectorIds));
		expect(get(selectedConnectorIds)).toEqual(new Set());

		// Flipping a connector ON in the workspace tab reaches the next new chat.
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection(null, get(defaultConnectorIds));
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-a"]));

		// And flipping it back OFF reaches the one after that.
		defaultConnectorIds.set(new Set());
		openConversationSelection(null, get(defaultConnectorIds));
		expect(get(selectedConnectorIds)).toEqual(new Set());
	});

	it("a reopened new chat re-seeds from defaults even after composer divergence", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection(null, get(defaultConnectorIds));

		// The composer diverges within the mount: off, and one on that is not a default.
		toggleConnector("conn-a");
		toggleConnector("conn-b");
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-b"]));

		// Returning home reopens the new-chat selection: the divergence is gone,
		// the current defaults are back.
		openConversationSelection(null, get(defaultConnectorIds));
		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-a"]));
	});

	it("composer edits survive within a mount while the new chat stays open", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection(null, get(defaultConnectorIds));

		toggleConnector("conn-a");

		// No reopen between: the first toggle diverges without touching the defaults.
		expect(get(selectedConnectorIds)).toEqual(new Set());
		expect(get(defaultConnectorIds)).toEqual(new Set(["conn-a"]));
	});
});

describe("the first message of a new chat", () => {
	it("keeps the connectors switched on at home when its conversation page opens", () => {
		// Nothing in the defaults: the person switches jmcp on for this one chat.
		openConversationSelection(null, get(defaultConnectorIds));
		toggleConnector("conn-jmcp");

		// The home page creates the conversation, hands its selection over, and
		// navigates; the conversation page then opens the new id with the defaults
		// as the seed — which used to win, so the first message went without it.
		adoptNewChatSelection("chat-new");
		openConversationSelection("chat-new", get(defaultConnectorIds));

		expect(get(selectedConnectorIds)).toEqual(new Set(["conn-jmcp"]));
		expect(localStorage.getItem(conversationKey("chat-new"))).toContain("conn-jmcp");
		// And the defaults did not move.
		expect(get(defaultConnectorIds)).toEqual(new Set());
	});

	it("keeps a default switched off at home off in the new conversation", () => {
		defaultConnectorIds.set(new Set(["conn-a"]));
		openConversationSelection(null, get(defaultConnectorIds));
		toggleConnector("conn-a");

		adoptNewChatSelection("chat-new");
		openConversationSelection("chat-new", get(defaultConnectorIds));

		expect(get(selectedConnectorIds)).toEqual(new Set());
	});
});
