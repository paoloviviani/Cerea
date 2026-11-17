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

/** A phone (no desktop breakpoint) or a desktop window, as window.matchMedia sees it. */
function stubViewport(desktop: boolean) {
	vi.stubGlobal("matchMedia", (query: string) => ({
		matches: query.includes("min-width") ? desktop : false,
		media: query,
		onchange: null,
		addEventListener() {},
		removeEventListener() {},
		addListener() {},
		removeListener() {},
		dispatchEvent: () => false,
	}));
}

const model = { id: "m", name: "M", providers: [] } as never;

const message = (id: string, from: "user" | "assistant", content: string) => ({
	id,
	from,
	content,
	createdAt: new Date(),
	updatedAt: new Date(),
	children: [],
	ancestors: [],
});

const V1 = '<artifact identifier="landing" type="html" title="Landing page"><p>one</p></artifact>';
const V2 = '<artifact identifier="landing" type="html" title="Landing page"><p>two</p></artifact>';

function mount(messages: ReturnType<typeof message>[], loading: boolean) {
	return renderWithApp(
		ChatWindow,
		{ messages, models: [model], currentModel: model, conversationTitle: "T", loading },
		{
			page: {
				url: "/conversation/conv-auto",
				route: { id: "/conversation/[id]" },
				params: { id: "conv-auto" },
				data: {},
			},
			context: new Map<unknown, unknown>([
				["settings", writable({ directPaste: false })],
				[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
			]),
		}
	);
}

// The streaming turn: v1 is complete, v2 is arriving (unclosed tag).
const STREAMING = [
	message("a1", "assistant", V1),
	message("a2", "assistant", V2.replace("</artifact>", "")),
];
const SETTLED = [message("a1", "assistant", V1), message("a2", "assistant", V2)];

describe("a new artifact version and the panel", () => {
	it("on a phone, never opens the panel by itself", async () => {
		stubViewport(false);
		const screen = await mount(STREAMING, true);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sidePane.open).toBe(false);
		screen.unmount();
	});

	it("on a phone, a tap on the card opens the latest version", async () => {
		stubViewport(false);
		const screen = await mount(SETTLED, false);
		const cards = screen.baseElement.querySelectorAll(
			'button[aria-label="Open file: Landing page"]'
		);
		expect(cards.length).toBe(2);
		expect(sidePane.open).toBe(false);
		// Only the newest card carries the hint.
		expect(cards[0].querySelector('[data-testid="artifact-card-updated"]')).toBeNull();
		expect(cards[1].querySelector('[data-testid="artifact-card-updated"]')).not.toBeNull();
		(cards[1] as HTMLButtonElement).click();
		await vi.waitFor(() => expect(sidePane.open).toBe(true));
		expect(sidePane.identifier).toBe("landing");
		expect(sidePane.version).toBeNull();
		screen.unmount();
	});

	it("on a phone, an already open panel keeps following the newest version", async () => {
		stubViewport(false);
		sidePane.openArtifact("landing", null);
		const screen = await mount(STREAMING, true);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(sidePane.open).toBe(true);
		expect(sidePane.version).toBeNull();
		screen.unmount();
	});

	it("on desktop, still opens the panel when a version starts streaming", async () => {
		stubViewport(true);
		const screen = await mount(STREAMING, true);
		await vi.waitFor(() => expect(sidePane.open).toBe(true));
		expect(sidePane.identifier).toBe("landing");
		screen.unmount();
	});
});
