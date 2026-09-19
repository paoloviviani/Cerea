import ChatWindow from "./ChatWindow.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { exportFilename } from "$lib/utils/exportConversationMarkdown";

// ChatWindow reaches the MCP stores, which read `$env/dynamic/public` and
// kick off a module-scope `refreshMcpServers()` fetch on import; the client
// project runs in a real browser where no SvelteKit env or API exists. The
// mock is hoisted above imports, so the real module — and its import-time
// network call — never load.
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
		initWithServers: vi.fn(),
		refreshMcpServers: vi.fn(async () => []),
		toggleServer: vi.fn(),
		disableAllServers: vi.fn(),
		updateServerStatus: vi.fn(),
		healthCheckServer: vi.fn(async () => ({ status: "unknown" })),
	};
});
// Same reason as mcpServers: mcpConnectors refreshes at module scope on import.
vi.mock("$lib/stores/mcpConnectors", async () => {
	const { writable, derived } = await import("svelte/store");
	const { vi } = await import("vitest");
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

const model = { id: "deepseek-r1", displayName: "DeepSeek-R1", isRouter: false } as never;

const messages = [
	{ id: "user-1", from: "user", content: "What is 2+2?", children: ["assistant-1"] },
	{
		id: "assistant-1",
		from: "assistant",
		content: "<think>adding numbers</think>It is 4.",
		reasoning: "server-side trace",
		ancestors: ["user-1"],
		children: [],
	},
] as never;

const mountConversation = async () => {
	// The export/share controls are desktop-only (`hidden md:flex`); widen the
	// viewport so they are interactable, like a real desktop chat window.
	await (browserPage as unknown as { viewport: (w: number, h: number) => Promise<void> }).viewport(
		1280,
		800
	);
	return renderWithApp(
		ChatWindow,
		{ messages, models: [model], currentModel: model, conversationTitle: "Export Me" },
		{
			page: {
				route: { id: "/conversation/[id]" },
				params: { id: "conv123456" },
				data: {},
			},
			// ChatWindow reads the layout-owned settings and conversations
			// stores from context; the harness only provides publicConfig.
			context: new Map<unknown, unknown>([
				["settings", writable({ directPaste: false })],
				[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
			]),
		}
	);
};

describe("conversation Markdown export", () => {
	it("shows a menu button opening the artifacts pane, not an export button", async () => {
		const screen = await mountConversation();
		await expect
			.element(screen.getByRole("button", { name: "Open artifacts panel" }))
			.toBeVisible();
		const buttons = await screen
			.getByRole("button", { name: "Export conversation as Markdown" })
			.elements();
		expect(buttons).toHaveLength(0);
		screen.unmount();
	});

	it("hides the menu button outside conversations", async () => {
		const screen = renderWithApp(
			ChatWindow,
			{ messages: [], models: [model], currentModel: model },
			{
				page: { route: { id: "/" }, params: {}, data: {} },
				context: new Map<unknown, unknown>([
					["settings", writable({ directPaste: false })],
					[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
				]),
			}
		);
		const buttons = await screen.getByRole("button", { name: "Open artifacts panel" }).elements();
		expect(buttons).toHaveLength(0);
		screen.unmount();
	});

	it("exports from the artifacts pane with reasoning as <slug>-<shortid>.md", async () => {
		const blobs: Blob[] = [];
		const clickedAnchors: HTMLAnchorElement[] = [];
		vi.spyOn(URL, "createObjectURL").mockImplementation(((blob: Blob) => {
			blobs.push(blob);
			return "blob:mock";
		}) as never);
		vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
		vi.spyOn(window.HTMLAnchorElement.prototype, "click").mockImplementation(function (
			this: HTMLAnchorElement
		) {
			clickedAnchors.push(this);
		});

		const screen = await mountConversation();
		// The export moved into the pane: open it through the menu button, then
		// run the same action from its new home. Direct clicks: Playwright's
		// actionability retry loop never settles on this page because the scroll
		// controller continuously re-measures layout.
		(
			screen.getByRole("button", { name: "Open artifacts panel" }).element() as HTMLButtonElement
		).click();
		const exportButtonLocator = screen.getByRole("button", {
			name: "Export conversation as Markdown",
		});
		await expect.element(exportButtonLocator).toBeVisible();
		const exportButton = exportButtonLocator.element() as HTMLButtonElement;
		exportButton.click();

		expect(blobs).toHaveLength(1);
		const markdown = await blobs[0].text();
		expect(markdown).toContain("# Export Me");
		expect(markdown).toContain("## Assistant (DeepSeek-R1)");
		expect(markdown).toContain("<summary>Thinking</summary>");
		expect(markdown).toContain("server-side trace");
		expect(markdown).toContain("adding numbers");
		expect(markdown).toContain("It is 4.");
		expect(markdown).not.toContain("<think>");

		expect(clickedAnchors).toHaveLength(1);
		expect(clickedAnchors[0].download).toBe(exportFilename("Export Me", "conv123456"));
		screen.unmount();
	});
});
