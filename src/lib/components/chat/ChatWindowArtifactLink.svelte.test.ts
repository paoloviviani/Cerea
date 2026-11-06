import ChatWindow from "./ChatWindow.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";

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

beforeEach(() => {
	sidePane.reset();
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
	vi.unstubAllGlobals();
	sidePane.reset();
});

const model = { id: "m", name: "M", providers: [] } as never;

const message = (content: string) => ({
	id: "a1",
	from: "assistant" as const,
	content,
	createdAt: new Date(),
	updatedAt: new Date(),
	children: [],
	ancestors: [],
});

const PAGE = '<artifact identifier="landing" type="html" title="Landing page"><p>hi</p></artifact>';

function mount(url: string) {
	return renderWithApp(
		ChatWindow,
		{ messages: [message(PAGE)], models: [model], currentModel: model, conversationTitle: "T" },
		{
			page: { url, route: { id: "/conversation/[id]" }, params: { id: "conv-link" }, data: {} },
			context: new Map<unknown, unknown>([
				["settings", writable({ directPaste: false })],
				[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
			]),
		}
	);
}

describe("opening a chat from the Artifacts tab", () => {
	it("?artifact= opens that artifact in the side pane", async () => {
		const screen = await mount("/conversation/conv-link?artifact=landing");
		await vi.waitFor(() => expect(sidePane.open).toBe(true));
		expect(sidePane.view).toBe("artifact");
		expect(sidePane.identifier).toBe("landing");
		screen.unmount();
	});

	it("leaves the pane shut when the chat has no such artifact, or no link was followed", async () => {
		const missing = await mount("/conversation/conv-link?artifact=nothing");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sidePane.open).toBe(false);
		missing.unmount();
		const plain = await mount("/conversation/conv-link");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(sidePane.open).toBe(false);
		plain.unmount();
	});
});
