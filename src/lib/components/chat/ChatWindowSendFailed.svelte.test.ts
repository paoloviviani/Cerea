import ChatWindow from "./ChatWindow.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";

// Same mocks as ChatWindow.svelte.test.ts: ChatWindow reaches the MCP stores,
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
		allBaseServersEnabled: writable(true),
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

const model = {
	id: "m",
	name: "M",
	providers: [],
} as never;

async function mountWithFailedText(text: string | null) {
	await (browserPage as unknown as { viewport: (w: number, h: number) => Promise<void> }).viewport(
		1280,
		800
	);
	return renderWithApp(
		ChatWindow,
		{
			messages: [],
			models: [model],
			currentModel: model,
			conversationTitle: "T",
			sendFailedText: text,
		},
		{
			page: {
				route: { id: "/conversation/[id]" },
				params: { id: "conv-failed-send" },
				data: {},
			},
			context: new Map<unknown, unknown>([
				["settings", writable({ directPaste: false })],
				[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
			]),
		}
	);
}

describe("a failed fresh send", () => {
	it("puts its text back in the composer for editing", async () => {
		const screen = await mountWithFailedText("rewrite me");
		const box = screen.container.querySelector("textarea");
		if (!box) throw new Error("no composer textarea");
		await expect.element(box).toHaveValue("rewrite me");
		screen.unmount();
	});
});
