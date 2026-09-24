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
	askUserQuestionTool: {
		type: "function",
		function: { name: "ask_user_question", description: "with setBudgetUsd" },
	},
	askUserQuestionToolPlain: {
		type: "function",
		function: { name: "ask_user_question", description: "no budget grants" },
	},
	openAskPrompt: mocks.openAskPrompt,
}));

vi.mock("$lib/server/database", () => ({
	collections: { conversations: { updateOne: vi.fn() } },
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const configuredBackend = vi.fn(() => "direct" as string);
vi.mock("$lib/server/fetching", () => ({ configuredBackend }));

const { getEnabledBuiltinTools, shouldSkipMcpFlow } = await import("./index");
const { askUserQuestionBuiltin } = await import("./askUserQuestion");
const { WEB_FETCH_STRUCTURED_TOOL_NAME } = await import("./webFetchStructuredTool");

const toolNames = (conv: Parameters<typeof getEnabledBuiltinTools>[0]["conv"]) =>
	getEnabledBuiltinTools({ conv }).map((tool) => tool.name);

beforeEach(() => {
	mocks.openAskPrompt.mockReset();
	mocks.openAskPrompt.mockResolvedValue({ opened: true });
	configuredBackend.mockReset();
	configuredBackend.mockReturnValue("direct");
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

describe("web_fetch_structured enablement (ADR 0079): needs the playwright backend AND a reachable renderer", () => {
	// The happy-path baseline: web access consented to, a URL to act on, the
	// backend selected, and the renderer answering. Individual tests knock
	// out exactly one of these to prove it is actually required.
	const webAccessParams = {
		conv: { _id: new ObjectId(), webSearch: true },
		allowedFetchUrls: new Set(["https://example.org/"]),
		playwrightReachable: true,
	};

	// Negative case first: `page.ariaSnapshot()` only exists because a real
	// browser rendered the page, so a deployment configured for `direct` (no
	// browser at all) or `pystino` (a deliberate stub) must not advertise a
	// tool that will always fail the moment it is called.
	it("withholds the tool on the direct backend", () => {
		configuredBackend.mockReturnValue("direct");
		const tools = getEnabledBuiltinTools(webAccessParams).map((tool) => tool.name);
		expect(tools).not.toContain(WEB_FETCH_STRUCTURED_TOOL_NAME);
	});

	it("withholds the tool on the pystino backend", () => {
		configuredBackend.mockReturnValue("pystino");
		const tools = getEnabledBuiltinTools(webAccessParams).map((tool) => tool.name);
		expect(tools).not.toContain(WEB_FETCH_STRUCTURED_TOOL_NAME);
	});

	// The second negative case, and the point of this change: selecting
	// `playwright` is a configuration a deployment can hold before the
	// overlay is even deployed (the admin panel deliberately still allows
	// that — see its own route/component), so the backend being *configured*
	// is not evidence it currently *works*. An unreachable renderer must
	// withhold the tool exactly as a wrong backend would, or the model pays
	// for a call that cannot succeed.
	it("withholds the tool when playwright is configured but the renderer is not reachable", () => {
		configuredBackend.mockReturnValue("playwright");
		const tools = getEnabledBuiltinTools({
			...webAccessParams,
			playwrightReachable: false,
		}).map((tool) => tool.name);
		expect(tools).not.toContain(WEB_FETCH_STRUCTURED_TOOL_NAME);
	});

	it("also withholds the tool when the caller never resolved a reachability probe", () => {
		configuredBackend.mockReturnValue("playwright");
		const tools = getEnabledBuiltinTools({
			conv: webAccessParams.conv,
			allowedFetchUrls: webAccessParams.allowedFetchUrls,
		}).map((tool) => tool.name);
		expect(tools).not.toContain(WEB_FETCH_STRUCTURED_TOOL_NAME);
	});

	it("offers the tool once the backend is playwright and the renderer answers", () => {
		configuredBackend.mockReturnValue("playwright");
		const tools = getEnabledBuiltinTools(webAccessParams).map((tool) => tool.name);
		expect(tools).toContain(WEB_FETCH_STRUCTURED_TOOL_NAME);
	});

	it("still withholds the tool on a reachable playwright without the same web-access consent web_fetch needs", () => {
		configuredBackend.mockReturnValue("playwright");
		const tools = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			allowedFetchUrls: new Set(["https://example.org/"]),
			playwrightReachable: true,
		}).map((tool) => tool.name);
		expect(tools).not.toContain(WEB_FETCH_STRUCTURED_TOOL_NAME);
	});

	// `FETCH_BACKEND` is runtime-editable through the admin panel, and the
	// tool list is rebuilt once per turn — so the check must read the current
	// value each call rather than a value cached at module load.
	it("re-reads the backend on every call rather than caching it", () => {
		configuredBackend.mockReturnValue("direct");
		expect(getEnabledBuiltinTools(webAccessParams).map((tool) => tool.name)).not.toContain(
			WEB_FETCH_STRUCTURED_TOOL_NAME
		);
		configuredBackend.mockReturnValue("playwright");
		expect(getEnabledBuiltinTools(webAccessParams).map((tool) => tool.name)).toContain(
			WEB_FETCH_STRUCTURED_TOOL_NAME
		);
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
	it("tells the model to deliver first, never to ask for confirmation or instead of content", () => {
		expect(askUserQuestionBuiltin.preprompt).toMatch(/Never use it to confirm \("did it work\?"\)/);
		expect(askUserQuestionBuiltin.preprompt).toMatch(
			/or in the step that delivers content \(an artifact/
		);
		expect(askUserQuestionBuiltin.preprompt).toMatch(
			/"Other" free-text choice is added automatically; never add your own/
		);
	});

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

describe("ask_user_question beyond the ML Assistant preset", () => {
	it("joins an ordinary conversation when the deployment switch is on", () => {
		const names = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			askUserQuestionEnabled: true,
		}).map((tool) => tool.name);
		expect(names).toContain("ask_user_question");
	});

	it("stays out of an ordinary conversation when the switch is off", () => {
		const names = getEnabledBuiltinTools({ conv: { _id: new ObjectId() } }).map(
			(tool) => tool.name
		);
		expect(names).not.toContain("ask_user_question");
	});

	it("is offered once, not twice, in an ML Assistant conversation", () => {
		const names = getEnabledBuiltinTools({
			conv: { _id: new ObjectId(), mlAssistant: true },
			askUserQuestionEnabled: true,
		}).map((tool) => tool.name);
		expect(names.filter((name) => name === "ask_user_question")).toHaveLength(1);
	});

	it("offers setBudgetUsd only inside the preset that can grant budget", () => {
		const definitionIn = (conv: { _id: ObjectId; mlAssistant?: boolean }) =>
			getEnabledBuiltinTools({ conv, askUserQuestionEnabled: true }).find(
				(tool) => tool.name === "ask_user_question"
			)?.definition.function.description;
		expect(definitionIn({ _id: new ObjectId() })).toBe("no budget grants");
		expect(definitionIn({ _id: new ObjectId(), mlAssistant: true })).toBe("with setBudgetUsd");
	});
});
