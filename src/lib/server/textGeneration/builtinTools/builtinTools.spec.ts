import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import type { ElicitationSink } from "$lib/server/mcp/elicitation";

const mocks = vi.hoisted(() => ({
	openAskPrompt: vi.fn(),
}));

vi.mock("$lib/server/askUserQuestion", () => ({
	ASK_USER_QUESTION_TOOL_NAME: "ask_user_question",
	askUserQuestionTool: {
		type: "function",
		function: { name: "ask_user_question", description: "ask" },
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
	it("offers nothing by default", () => {
		expect(toolNames({ _id: new ObjectId() })).toEqual([]);
	});
});

describe("the plan tool", () => {
	it("is offered in any chat whose turn has tool calling on", () => {
		const names = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			toolsEnabled: true,
		}).map((tool) => tool.name);
		expect(names).toContain("update_plan");
	});

	it("is withheld when tool calling is off or unresolved", () => {
		expect(toolNames({ _id: new ObjectId() })).not.toContain("update_plan");
		const off = getEnabledBuiltinTools({ conv: { _id: new ObjectId() }, toolsEnabled: false });
		expect(off.map((tool) => tool.name)).not.toContain("update_plan");
	});

	it("carries a short preprompt that says when to use it and when not", () => {
		const tool = getEnabledBuiltinTools({ conv: { _id: new ObjectId() }, toolsEnabled: true }).find(
			(t) => t.name === "update_plan"
		);
		expect(tool?.preprompt).toMatch(/multi-step/);
		expect(tool?.preprompt).toMatch(/Not for simple/);
		expect((tool?.preprompt ?? "").length).toBeLessThan(500);
	});
});

describe("sub-agent tools", () => {
	const webParams = {
		conv: { _id: new ObjectId() },
		toolsEnabled: true,
		webSearchEnabled: true,
		token: "t",
		searchModelIds: ["exa"],
		allowedFetchUrls: new Set<string>(),
		delegation: { models: [] },
	};
	const names = (params: Parameters<typeof getEnabledBuiltinTools>[0]) =>
		getEnabledBuiltinTools(params).map((tool) => tool.name);

	it("offers delegate to a tool-capable chat when the deployment allows it", () => {
		expect(
			names({ conv: { _id: new ObjectId() }, toolsEnabled: true, delegation: { models: [] } })
		).toContain("delegate");
	});

	it("offers nothing when the caller passes no delegation (the switch is off)", () => {
		const off = { ...webParams, delegation: undefined };
		expect(names(off)).not.toContain("delegate");
		expect(names(off)).not.toContain("research");
	});

	it("offers nothing without tool calling", () => {
		expect(names({ ...webParams, toolsEnabled: false })).not.toContain("delegate");
	});

	it("offers research where web search is, and not otherwise", () => {
		expect(names(webParams)).toEqual(expect.arrayContaining(["delegate", "research"]));
		expect(names({ ...webParams, webSearchEnabled: false })).not.toContain("research");
		expect(names({ ...webParams, searchModelIds: [] })).not.toContain("research");
		expect(names({ ...webParams, webSearchEnabled: false })).toContain("delegate");
	});

	it("puts a short guidance on when to delegate in the preprompt", () => {
		const tool = getEnabledBuiltinTools(webParams).find((t) => t.name === "delegate");
		expect(tool?.preprompt).toMatch(/self-contained/);
		expect(tool?.preprompt).toMatch(/parallel/);
		expect(tool?.preprompt).toMatch(/Do not delegate/);
		expect((tool?.preprompt ?? "").length).toBeLessThan(900);
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

describe("ask_user_question enablement", () => {
	it("joins a conversation when the deployment switch is on", () => {
		const names = getEnabledBuiltinTools({
			conv: { _id: new ObjectId() },
			askUserQuestionEnabled: true,
		}).map((tool) => tool.name);
		expect(names).toContain("ask_user_question");
	});

	it("stays out of a conversation when the switch is off", () => {
		const names = getEnabledBuiltinTools({ conv: { _id: new ObjectId() } }).map(
			(tool) => tool.name
		);
		expect(names).not.toContain("ask_user_question");
	});
});

describe("look_doc", () => {
	const documentCapabilities = {
		formats: {},
		render: { formats: ["pdf"], image_types: ["png", "jpeg"] },
	};
	const names = (extra: Partial<Parameters<typeof getEnabledBuiltinTools>[0]>) =>
		getEnabledBuiltinTools({ conv: { _id: new ObjectId() }, ...extra }).map((tool) => tool.name);

	it("is offered when the model sees images and the document service draws pages", () => {
		expect(names({ documentCapabilities, modelSeesImages: true })).toContain("look_doc");
	});

	it("is absent for a text-only model, however the service is set up", () => {
		expect(names({ documentCapabilities, modelSeesImages: false })).not.toContain("look_doc");
		expect(names({ documentCapabilities })).not.toContain("look_doc");
	});

	it("is absent without a document service or without its render capability", () => {
		expect(names({ modelSeesImages: true })).not.toContain("look_doc");
		expect(names({ documentCapabilities: null, modelSeesImages: true })).not.toContain("look_doc");
		expect(names({ documentCapabilities: { formats: {} }, modelSeesImages: true })).not.toContain(
			"look_doc"
		);
	});
});

describe("a scheduled run's tools", () => {
	const conv = { _id: new ObjectId() };
	const names = (extra: Partial<Parameters<typeof getEnabledBuiltinTools>[0]> = {}) =>
		getEnabledBuiltinTools({ conv, toolsEnabled: true, ...extra }).map((tool) => tool.name);

	it("withholds what parks the turn on a person: questions, and with them the browser sandbox", () => {
		expect(names({ askUserQuestionEnabled: true })).toContain("ask_user_question");
		expect(names({ askUserQuestionEnabled: true, unattended: true })).not.toContain(
			"ask_user_question"
		);
		// Everything else a chat has stays: the plan, and server-side tools.
		expect(names({ unattended: true })).toContain("update_plan");
	});

	it("never carries any tool that can park, whatever it is", () => {
		const tools = getEnabledBuiltinTools({
			conv,
			toolsEnabled: true,
			askUserQuestionEnabled: true,
			unattended: true,
		});
		expect(tools.filter((tool) => tool.mayPark)).toEqual([]);
	});

	it("offers the schedule tool to a signed-in person's chat, never to a run nobody watches", () => {
		expect(names()).not.toContain("schedule");
		expect(names({ scheduling: { timezone: "Europe/Rome" } })).toContain("schedule");
		expect(names({ scheduling: {}, unattended: true })).not.toContain("schedule");
		expect(getEnabledBuiltinTools({ conv, scheduling: {} }).map((tool) => tool.name)).not.toContain(
			"schedule"
		);
	});
});
