import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { ElicitationSink } from "$lib/server/mcp/elicitation";

const mocks = vi.hoisted(() => ({
	openAskPrompt: vi.fn(),
}));

// The gate itself is real; only the build flag behind it is forced on.
vi.mock("$lib/utils/mlAssistantFlag", () => ({ ML_ASSISTANT_MODE: true }));

vi.mock("$lib/server/askUserQuestion", () => ({
	ASK_USER_QUESTION_TOOL_NAME: "ask_user_question",
	askUserQuestionTool: { type: "function", function: { name: "ask_user_question" } },
	openAskPrompt: mocks.openAskPrompt,
}));

vi.mock("$lib/server/database", () => ({
	collections: { conversations: { updateOne: vi.fn() } },
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { getEnabledBuiltinTools, shouldSkipMcpFlow } = await import("./index");
const { askUserQuestionBuiltin } = await import("./askUserQuestion");

const toolNames = (conv: Parameters<typeof getEnabledBuiltinTools>[0]["conv"]) =>
	getEnabledBuiltinTools({ conv }).map((tool) => tool.name);

beforeEach(() => {
	mocks.openAskPrompt.mockReset();
	mocks.openAskPrompt.mockResolvedValue({ opened: true });
});

describe("getEnabledBuiltinTools", () => {
	it("offers the preset's builtin tools in an ML Assistant conversation", () => {
		expect(toolNames({ _id: new ObjectId(), mlAssistant: true })).toEqual([
			"ask_user_question",
			"update_plan",
			"wait",
			"research",
			"sandbox_task",
			"check_job",
			"create_trackio",
		]);
	});

	it("offers nothing outside the mode", () => {
		expect(toolNames({ _id: new ObjectId() })).toEqual([]);
		expect(toolNames({ _id: new ObjectId(), mlAssistant: false })).toEqual([]);
	});
});

describe("web search enablement: per-chat state beats the passed default", () => {
	const searchParams = {
		token: "caller-token",
		searchModelIds: ["search-backend"],
		allowedFetchUrls: new Set(["https://example.org/"]),
	};

	it("offers search tools when the caller default is on and the chat is unset", () => {
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			webSearchEnabled: true,
			...searchParams,
		});
		expect(tools.map((tool) => tool.name)).toContain("web_search");
	});

	it("withholds search tools when the chat explicitly opts out of a default of on", () => {
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId(), webSearch: false },
			webSearchEnabled: true,
			...searchParams,
		});
		expect(tools.map((tool) => tool.name)).not.toContain("web_search");
	});

	it("offers search tools when the chat opts in over a default of off", () => {
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId(), webSearch: true },
			...searchParams,
		});
		expect(tools.map((tool) => tool.name)).toContain("web_search");
	});

	it("offers nothing when both chat and default are off", () => {
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			...searchParams,
		});
		expect(tools.map((tool) => tool.name)).not.toContain("web_search");
	});
});

describe("shouldSkipMcpFlow", () => {
	it("skips only when there is neither a server nor a builtin tool", () => {
		expect(shouldSkipMcpFlow(0, 0)).toBe(true);
		expect(shouldSkipMcpFlow(1, 0)).toBe(false);
		expect(shouldSkipMcpFlow(0, 1)).toBe(false);
		expect(shouldSkipMcpFlow(2, 3)).toBe(false);
	});
});

describe("askUserQuestionBuiltin", () => {
	const sink: ElicitationSink = { conversationId: new ObjectId(), emit: vi.fn() };
	const args = { questions: [] };

	it("opens the prompt through the sink and parks", async () => {
		const outcome = await askUserQuestionBuiltin.execute(args, {
			uuid: "u1",
			toolCallId: "c1",
			messageId: "m1",
			elicitationSink: sink,
		});

		expect(outcome).toEqual({ awaitingInput: true });
		expect(mocks.openAskPrompt).toHaveBeenCalledWith({
			sink,
			toolUuid: "u1",
			toolCallId: "c1",
			messageId: "m1",
			args,
		});
	});

	it("surfaces the reason when the prompt cannot be shown", async () => {
		mocks.openAskPrompt.mockResolvedValue({ opened: false, reason: "no questions were given" });
		const outcome = await askUserQuestionBuiltin.execute(args, {
			uuid: "u1",
			toolCallId: "c1",
			elicitationSink: sink,
		});
		expect("error" in outcome && outcome.error).toContain("no questions were given");
	});

	it("errors without opening anything when there is no chat to ask", async () => {
		const outcome = await askUserQuestionBuiltin.execute(args, { uuid: "u1", toolCallId: "c1" });
		expect(mocks.openAskPrompt).not.toHaveBeenCalled();
		expect("error" in outcome && outcome.error).toContain("no chat to ask");
	});
});
