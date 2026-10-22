import { render } from "svelte/server";
import { describe, it, expect, vi } from "vitest";
import { writable } from "svelte/store";
import { getConfigManager } from "$lib/utils/PublicConfig.svelte";
import ChatWindow from "./ChatWindow.svelte";
import { MessageUpdateType, MessageCodeExecutionUpdateType } from "$lib/types/MessageUpdate";

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

const SHA = "a".repeat(64);

const messages = [
	{ id: "user-1", from: "user", content: "make a csv", children: ["assistant-1"] },
	{
		id: "assistant-1",
		from: "assistant",
		content: "Done.",
		ancestors: ["user-1"],
		children: [],
		updates: [
			{
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Request,
				executionId: "e1",
				code: "open('out.csv','w').write('a,b')",
			},
			{
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Resolved,
				executionId: "e1",
				outcome: { ok: true, stdout: "", stderr: "" },
				files: [{ name: "out.csv", size: 3, sha256: SHA }],
			},
		],
	},
] as never;

describe("ChatWindow SSR with persisted run files", () => {
	it("renders a conversation whose run produced files", () => {
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
		expect(body).toContain("out.csv");
	});
});
