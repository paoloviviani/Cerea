import HomePage from "./+page.svelte";
import { renderWithApp, appNavigation } from "$lib/components/__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { newConversationsStore, CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";

/**
 * The new-chat page after the server replaced failed first chats: the sidebar
 * drops the ids the create response names, then shows the new chat.
 */
// Same mocks as ChatWindowSendFailed.svelte.test.ts: ChatWindow reaches the MCP stores,
// which read `$env/dynamic/public` and kick off a module-scope
// `refreshMcpServers()` fetch on import; the client project runs in a real
// browser where no SvelteKit env or API exists.
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/stores/mcpServers", async () => {
	const { writable, derived } = await import("svelte/store");
	const { vi } = await import("vitest");
	const allMcpServers = writable([]);
	const selectedServerIds = writable(new Set<string>());
	const enabledServers = derived([allMcpServers, selectedServerIds], ([$a, $s]) =>
		($a as { id: string }[]).filter((s) => ($s as Set<string>).has(s.id))
	);
	return {
		allMcpServers,
		selectedServerIds,
		enabledServers,
		enabledServersCount: derived(enabledServers, ($enabled) => ($enabled as unknown[]).length),
		mcpServersLoaded: writable(true),
		toggleServer: vi.fn(),
		disableAllServers: vi.fn(),
		healthCheckServer: vi.fn(async () => ({ status: "unknown" })),
	};
});
vi.mock("$lib/stores/mcpConnectors", async () => {
	const { writable, derived } = await import("svelte/store");
	const connectors = writable([]);
	const selectedConnectorIds = writable(new Set<string>());
	const enabledConnectors = derived([connectors, selectedConnectorIds], ([$a, $s]) =>
		($a as { id: string }[]).filter((c) => ($s as Set<string>).has(c.id))
	);
	return {
		connectors,
		connectorsLoaded: writable(true),
		connectorsFailed: writable(false),
		selectedConnectorIds,
		enabledConnectors,
		enabledConnectorsCount: derived(enabledConnectors, ($e) => ($e as unknown[]).length),
		totalEnabledMcpCount: derived(enabledConnectors, () => 0),
		refreshConnectors: vi.fn(async () => {}),
		toggleConnector: vi.fn(),
		disableAllConnectors: vi.fn(),
		selectConnector: vi.fn(),
		migrateCustomServers: vi.fn(async () => 0),
		addConnector: vi.fn(async () => ({})),
	};
});

const model = { id: "m", name: "M", displayName: "M", providers: [] } as never;

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/conversation"))
				return Response.json({ conversationId: "new1", replaced: ["old1", "old2"] });
			return new Response("{}", { status: 200 });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("the new-chat page", () => {
	it("drops the failed chats the server replaced from the sidebar", async () => {
		await (
			browserPage as unknown as { viewport: (w: number, h: number) => Promise<void> }
		).viewport(1280, 800);
		const store = newConversationsStore();
		store.prepend({ id: "old1", title: "Hello", model: "m", updatedAt: new Date() });
		store.prepend({ id: "old2", title: "Hello", model: "m", updatedAt: new Date() });
		store.prepend({ id: "keep", title: "Other", model: "m", updatedAt: new Date() });
		const screen = renderWithApp(
			HomePage,
			{ data: { models: [model], oldModels: [], codeAgentsEnabled: false } } as never,
			{
				page: { route: { id: "/" }, data: {} },
				context: new Map<unknown, unknown>([
					["settings", writable({ directPaste: false, activeModel: "m" })],
					[CONVERSATIONS_CONTEXT_KEY, store],
				]),
			}
		);
		const box = screen.container.querySelector("textarea") as HTMLTextAreaElement;
		box.focus();
		box.value = "Hello again";
		box.dispatchEvent(new Event("input", { bubbles: true }));
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		await vi.waitFor(() => expect(appNavigation().goto).toHaveBeenCalled());
		const ids = store.list.map((c) => c.id);
		expect(ids).toContain("new1");
		expect(ids).toContain("keep");
		expect(ids).not.toContain("old1");
		expect(ids).not.toContain("old2");
		screen.unmount();
	});
});
