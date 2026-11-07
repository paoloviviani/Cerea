import ChatWindow from "./ChatWindow.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page as browserPage } from "@vitest/browser/context";
import { CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { codeReauth, resetCodeReauth } from "$lib/stores/codeReauth.svelte";
import { clearPending } from "$lib/stores/codeNeedsYou.svelte";
import NeedsYouShell from "$lib/components/code/NeedsYouShell.svelte";
import { MessageUpdateType } from "$lib/types/MessageUpdate";

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

const fake = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: async () => ({
		devices: [{ id: "d1", name: "Box", status: "paired", online: true }],
	}),
	listPendingApprovals: async () => ({
		permissions: [
			{
				sessionId: "a1",
				workspaceId: "w1",
				sessionTitle: "Mine",
				request: {
					id: "p1",
					sessionId: "a1",
					tool: "bash",
					title: "Run it",
					patterns: [],
					metadata: {},
					always: [],
				},
			},
			{
				sessionId: "other",
				workspaceId: "w1",
				sessionTitle: "Someone else's",
				request: {
					id: "p2",
					sessionId: "other",
					tool: "edit",
					title: "Edit",
					patterns: [],
					metadata: {},
					always: [],
				},
			},
		],
		questions: [],
	}),
	respondPermission: async (...args: unknown[]) => {
		fake.calls.push(args);
		return { ok: true };
	},
	getAgent: async () => ({ agent: { permissionMode: "allow" } }),
}));
vi.mock("$lib/codeAgentStream", () => ({
	agentStreamUrl: () => "",
	async *codeAgentStream(_d: string, _a: string, signal: AbortSignal) {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
	},
}));

beforeEach(() => {
	sidePane.reset();
	resetCodeReauth();
	clearPending();
	fake.calls = [];
	codeDeviceList.devices = [
		{ id: "d1", name: "Box", status: "paired", online: true },
	] as typeof codeDeviceList.devices;
	codeDeviceList.loading = false;
	codeReauth.checked = true;
	vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});
afterEach(() => {
	vi.unstubAllGlobals();
	sidePane.reset();
	document.body.innerHTML = "";
});

const model = { id: "m", name: "M", providers: [] } as never;
const sessionUpdate = {
	type: MessageUpdateType.AgentSession,
	action: "started",
	deviceId: "d1",
	workspaceId: "w1",
	sessionId: "a1",
	title: "Mine",
	labels: { device: "Box", workspace: "repo" },
};

function mount(updates: unknown[], codeAgentsEnabled = true) {
	return renderWithApp(
		ChatWindow,
		{
			messages: [
				{ id: "u", from: "user", content: "go", children: ["m1"] },
				{ id: "m1", from: "assistant", content: "ok", ancestors: ["u"], updates },
			] as never,
			models: [model],
			currentModel: model,
			conversationTitle: "T",
		},
		{
			page: {
				route: { id: "/conversation/[id]" },
				params: { id: "conv-pinned" },
				data: { codeAgentsEnabled },
			},
			context: new Map<unknown, unknown>([
				["settings", writable({ directPaste: false })],
				[CONVERSATIONS_CONTEXT_KEY, { list: [] }],
			]),
		}
	);
}

const pinned = () => document.body.querySelector('[data-testid="needs-you-pinned"]');
const items = () => [...document.body.querySelectorAll('[data-testid="needs-you-item"]')];

describe("asks pinned above the composer", () => {
	it("shows the asks of the sessions this chat started, expanded, and answers inline", async () => {
		await browserPage.viewport(1200, 800);
		mount([sessionUpdate]);
		await vi.waitFor(() => expect(pinned()).not.toBeNull());
		// Only this chat's session, already open.
		expect(items()).toHaveLength(1);
		expect(pinned()?.textContent).toContain("Mine");
		expect(pinned()?.textContent).not.toContain("Someone else's");
		// Directly above the composer's form.
		const form = document.body.querySelector("form");
		expect(pinned()?.compareDocumentPosition(form as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
		// The DOM click, not a pointer click: the chat column's own layers sit over the
		// composer in this bare mount (the e2e spec clicks it for real).
		(
			[...document.body.querySelectorAll("button")].find((b) =>
				b.textContent?.includes("Allow once")
			) as HTMLElement
		).click();
		await vi.waitFor(() => expect(fake.calls).toEqual([["d1", "a1", "p1", "once"]]));
		await vi.waitFor(() => expect(pinned()).toBeNull());
	});

	it("takes those asks out of the app-wide bar: one question once per screen", async () => {
		await browserPage.viewport(1200, 800);
		renderWithApp(NeedsYouShell, { enabled: true }, { page: { route: { id: "/" }, data: {} } });
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('[data-testid="needs-you-inbox"]')?.textContent ?? ""
			).toContain("2 waiting for you")
		);
		mount([sessionUpdate]);
		await vi.waitFor(() => expect(pinned()).not.toBeNull());
		await vi.waitFor(() =>
			expect(
				document.body.querySelector('[data-testid="needs-you-inbox"]')?.textContent ?? ""
			).toContain("1 waiting for you")
		);
	});

	it("is not drawn for a chat with no agent session, nor without /code", async () => {
		await browserPage.viewport(1200, 800);
		const plain = mount([]);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(pinned()).toBeNull();
		plain.unmount();
		mount([sessionUpdate], false);
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(pinned()).toBeNull();
	});
});
