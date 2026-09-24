import { describe, expect, it, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("$lib/utils/mlAssistantFlag", () => ({ ML_ASSISTANT_MODE: true }));

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	executeToolCalls: vi.fn(),
	getAbortTime: vi.fn(),
	mcpTools: [] as unknown[],
	servers: [{ name: "hf", url: "https://example.test/mcp" }],
	multimodalFlags: [] as unknown[],
	codeToolEnabled: "true",
	askQuestionEnabled: undefined as string | undefined,
}));

vi.mock("openai", () => ({
	OpenAI: class {
		chat = { completions: { create: mocks.create } };
	},
}));
vi.mock("$lib/server/database", () => ({
	collections: {
		settings: { findOne: vi.fn(async () => null) },
		projects: { findOne: vi.fn(async () => null) },
	},
}));
vi.mock("$lib/server/config", () => ({
	config: { OPENAI_API_KEY: "k", OPENAI_BASE_URL: "http://x.test/v1" },
}));
vi.mock("$lib/server/mcp/registry", () => ({ getMcpServers: () => mocks.servers }));
vi.mock("$lib/server/urlSafety", () => ({ isValidUrl: () => true }));
vi.mock("$lib/server/mcp/tools", () => ({
	getOpenAiToolsForMcp: async () => ({ tools: [], mapping: {} }),
}));
vi.mock("./routerResolution", () => ({
	resolveRouterTarget: async ({ model }: { model: unknown }) => ({ runMcp: true, targetModel: model }),
}));
vi.mock("./toolInvocation", () => ({ executeToolCalls: mocks.executeToolCalls }));
vi.mock("$lib/server/textGeneration/utils/prepareFiles", () => ({
	prepareMessagesWithFiles: async (messages: Array<{ from: string; content: string }>) =>
		messages.map((m) => ({ role: m.from, content: m.content })),
}));
vi.mock("$lib/server/endpoints/images", () => ({ makeImageProcessor: () => () => undefined }));
vi.mock("./fileRefs", () => ({ buildImageRefResolver: () => undefined }));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/abortedGenerations", () => ({
	AbortedGenerations: { getInstance: () => ({ getAbortTime: mocks.getAbortTime }) },
}));
vi.mock("$lib/server/fetching", () => ({ configuredBackend: () => "direct" }));
vi.mock("$lib/server/memoryEnabled", () => ({ memoryEnabled: () => false }));
vi.mock("$lib/server/askUserQuestionEnabled", () => ({ askUserQuestionEnabled: () => true }));
vi.mock("$lib/server/webSearchDefaults", () => ({
	resolveWebSearchEnabled: () => false,
}));
vi.mock("$lib/server/textGeneration/builtinTools/gatewaySearchTool", () => ({
	findSearchModelIds: async () => [],
}));
vi.mock("$lib/server/fetching/playwright", () => ({
	probePlaywrightHealth: async () => ({ reachable: false }),
}));

const { runMcpFlow } = await import("./runMcpFlow");
const { MessageUpdateType } = await import("$lib/types/MessageUpdate");

const chunk = (choice: Record<string, unknown>) => ({ choices: [choice] });

describe("draft probe", () => {
	beforeEach(() => {
		mocks.create.mockReset();
		mocks.executeToolCalls.mockReset();
		mocks.getAbortTime.mockReturnValue(undefined);
		mocks.executeToolCalls.mockImplementation(async function* () {
			yield {
				type: "complete",
				summary: { toolMessages: [], toolRuns: [] },
			};
		});
	});

	it("emits ArtifactDraft while artifact args stream", async () => {
		const fullArgs = JSON.stringify({
			command: "create",
			identifier: "big-doc",
			type: "markdown",
			title: "Big Doc",
			content: "# Big\n\nhello world",
		});
		const slices: string[] = [];
		for (let at = 0; at < fullArgs.length; at += 10) slices.push(fullArgs.slice(at, at + 10));
		const deltas = slices.map((slice, si) => ({
			tool_calls: [
				si === 0
					? { index: 0, id: "call_1", function: { name: "artifact", arguments: slice } }
					: { index: 0, function: { arguments: slice } },
			],
		}));
		mocks.create.mockImplementationOnce(async () =>
			(async function* () {
				for (const d of deltas) yield chunk({ delta: d });
				yield chunk({ delta: {}, finish_reason: "tool_calls" });
			})()
		);
		mocks.create.mockImplementationOnce(async () =>
			(async function* () {
				yield chunk({ delta: { content: "Done." } });
				yield chunk({ delta: {}, finish_reason: "stop" });
			})()
		);

		const updates: unknown[] = [];
		const gen = runMcpFlow({
			model: {
				id: "t",
				name: "t",
				supportsTools: true,
				supportsArtifacts: true,
				parameters: {},
			},
			conv: { _id: new ObjectId() },
			messages: [{ from: "user", content: "hi" }],
			locals: {},
		} as unknown as Parameters<typeof runMcpFlow>[0]);
		let step = await gen.next();
		while (!step.done) {
			updates.push(step.value);
			step = await gen.next();
		}
		const drafts = (updates as Array<{ type: string }>).filter(
			(u) => u.type === MessageUpdateType.ArtifactDraft
		);
		console.log("DRAFTS:", JSON.stringify(drafts).slice(0, 500), "count=", drafts.length);
		expect(drafts.length).toBeGreaterThan(0);
	});
});
