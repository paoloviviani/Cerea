import { render } from "svelte/server";
import { describe, it, expect, vi } from "vitest";
import { writable } from "svelte/store";
import { getConfigManager } from "$lib/utils/PublicConfig.svelte";
import ChatWindow from "./ChatWindow.svelte";
import { MessageToolUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

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
		initWithServers: vi.fn(),
		refreshMcpServers: vi.fn(async () => []),
		toggleServer: vi.fn(),
		disableAllServers: vi.fn(),
		updateServerStatus: vi.fn(),
		healthCheckServer: vi.fn(async () => ({ status: "unknown" })),
	};
});

// Outside a request there is no SvelteKit page state to read.
vi.mock("$app/state", () => ({
	page: {
		route: { id: "/conversation/[id]" },
		params: { id: "c1" },
		url: new URL("http://localhost/conversation/c1"),
		data: {},
		form: null,
		error: null,
		status: 200,
		state: {},
	},
	navigating: { current: null },
	updated: { current: false, check: async () => false },
}));

const tool = (uuid: string, subtype: MessageToolUpdateType, extra: object) => ({
	type: MessageUpdateType.Tool,
	uuid,
	subtype,
	...extra,
});

const messages = [
	{ id: "user-1", from: "user", content: "compare A and B", children: ["assistant-1"] },
	{
		id: "assistant-1",
		from: "assistant",
		content: "Both are permissive.",
		ancestors: ["user-1"],
		children: [],
		updates: [
			tool("a", MessageToolUpdateType.Call, { call: { name: "delegate", parameters: {} } }),
			tool("b", MessageToolUpdateType.Call, { call: { name: "research", parameters: {} } }),
			{
				type: MessageUpdateType.SubAgent,
				uuid: "a",
				title: "Licence of A",
				model: "Big One",
				status: "done",
				steps: [{ tool: "web_search", label: "search A", outcome: "ok" }],
			},
			{
				type: MessageUpdateType.SubAgent,
				uuid: "b",
				title: "Licence of B",
				model: "Test Model",
				preset: "research",
				status: "done",
				steps: [],
			},
			tool("a", MessageToolUpdateType.Result, {
				result: {
					status: "success",
					call: { name: "delegate", parameters: {} },
					outputs: [{ text: "A is MIT." }],
					display: true,
				},
			}),
			tool("b", MessageToolUpdateType.Result, {
				result: {
					status: "success",
					call: { name: "research", parameters: {} },
					outputs: [{ text: "B is Apache-2.0." }],
					display: true,
				},
			}),
		],
	},
] as never;

describe("ChatWindow SSR with sub-agent cards", () => {
	it("renders a reloaded conversation with its sub-agents as cards, not tool rows", () => {
		const model = { id: "m", displayName: "M" } as never;
		const { body } = render(ChatWindow, {
			props: { messages, currentModel: model, models: [model] },
			context: new Map<string, unknown>([
				[
					"settings",
					writable({ multimodalOverrides: {}, hidePromptExamples: {}, recentlySaved: false }),
				],
				[
					"publicConfig",
					getConfigManager({
						PUBLIC_ORIGIN: "http://localhost:3000",
						PUBLIC_APP_NAME: "chat-ui",
						PUBLIC_APP_ASSETS: "chatui",
						PUBLIC_APP_DESCRIPTION: "test",
						PUBLIC_COMMIT_SHA: "test-sha",
						PUBLIC_VERSION: "test",
					}),
				],
			]),
		});
		expect(body.match(/data-testid="subagent-card"/g)).toHaveLength(2);
		expect(body).toContain("Licence of A");
		expect(body).toContain("Licence of B");
		expect(body).toContain("Big One");
		expect(body).toContain("A is MIT.");
		expect(body).toContain("B is Apache-2.0.");
		expect(body).not.toContain("Called tool");
	});
});
