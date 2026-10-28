import ChatWindow from "./ChatWindow.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
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

function mount(extra: { projectId?: string; projectName?: string }) {
	return renderWithApp(
		ChatWindow,
		{
			messages: [],
			models: [model],
			currentModel: model,
			conversationTitle: "T",
			...extra,
		},
		{
			page: {
				route: { id: "/conversation/[id]" },
				params: { id: "conv-project-back" },
				data: {},
			},
			context: new Map<unknown, unknown>([
				["settings", writable({ directPaste: false })],
				[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
			]),
		}
	);
}

describe("the way back to a chat's project", () => {
	it("links to the project's page, labelled with its name", async () => {
		await (
			browserPage as unknown as { viewport: (w: number, h: number) => Promise<void> }
		).viewport(390, 800);
		const screen = await mount({ projectId: "p1", projectName: "Padova 1 Novembre 2026" });
		const link = screen.container.querySelector<HTMLAnchorElement>("[data-testid=project-back]");
		if (!link) throw new Error("no back link");
		expect(link.getAttribute("href")).toMatch(/\/projects\/p1$/);
		expect(link.textContent).toContain("Padova 1 Novembre 2026");
		expect(link.getAttribute("aria-label")).toBe("Back to the project Padova 1 Novembre 2026");
		screen.unmount();
	});

	it("is absent for a chat outside a project, or without a readable name", async () => {
		const none = await mount({});
		expect(none.container.querySelector("[data-testid=project-back]")).toBeNull();
		none.unmount();
		const unnamed = await mount({ projectId: "p1" });
		expect(unnamed.container.querySelector("[data-testid=project-back]")).toBeNull();
		unnamed.unmount();
	});
});
