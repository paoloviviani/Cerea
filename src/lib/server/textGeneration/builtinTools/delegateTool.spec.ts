import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAI } from "openai";

const mocks = vi.hoisted(() => ({ callMcpTool: vi.fn() }));

vi.mock("$lib/server/database", () => ({
	collections: { nestedAgentCalls: { insertMany: () => Promise.resolve({}) } },
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/mcp/httpClient", () => ({
	callMcpTool: mocks.callMcpTool,
	getMcpToolTimeoutMs: () => 5_000,
}));
vi.mock("$lib/server/mcp/clientPool", () => ({ getClient: async () => ({}) }));
// The administrator's instructions come from the deployment config; a stand-in
// the cases below set.
const admin = vi.hoisted(() => ({ text: "" }));
vi.mock("$lib/server/config", () => ({
	config: new Proxy(
		{},
		{
			get: (_t, key) =>
				key === "getSaved"
					? () => undefined
					: key === "ADMIN_INSTRUCTIONS"
						? admin.text
						: undefined,
		}
	),
}));

const {
	createDelegateTools,
	describeCall,
	deriveTitle,
	MAX_PARALLEL_SUBAGENTS,
	MAX_SUBAGENTS_PER_TURN,
	RESEARCH_SYSTEM_PROMPT,
	SUBAGENT_MAX_STEPS,
	SUBAGENT_TIMEOUT_MS,
	SUBAGENT_TOKEN_BUDGET,
} = await import("./delegateTool");
import type { NestedAgentBuiltinTool, NestedAgentDeps } from "./nestedAgent";
import type { BuiltinTool, BuiltinToolContext } from "./types";
import type { MessageSubAgentUpdate } from "$lib/types/MessageUpdate";

type Req = {
	model?: string;
	temperature?: number;
	max_tokens?: number;
	messages: Array<{ role: string; content?: string | null }>;
	tools?: Array<{ function: { name: string } }>;
};
type Reply = {
	content?: string | null;
	calls?: Array<{ name: string; args?: object }>;
	wait?: Promise<void>;
};

function upstream(script: Array<Reply>) {
	const requests: Req[] = [];
	let next = 0;
	const create = vi.fn(async (req: Req) => {
		requests.push(req);
		const reply = script[Math.min(next, script.length - 1)];
		next += 1;
		if (reply.wait) await reply.wait;
		return {
			choices: [
				{
					finish_reason: reply.calls?.length ? "tool_calls" : "stop",
					message: {
						content: reply.content ?? null,
						tool_calls: (reply.calls ?? []).map((call, index) => ({
							id: `call_${next}_${index}`,
							type: "function",
							function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
						})),
					},
				},
			],
			usage: { total_tokens: 10 },
		};
	});
	return { openai: { chat: { completions: { create } } } as unknown as OpenAI, requests, create };
}

const builtin = (name: string, resultText = `${name} result`): BuiltinTool => ({
	name,
	definition: {
		type: "function",
		function: { name, description: name, parameters: { type: "object" } },
	},
	execute: async () => ({ resultText }),
});

const mcpDef = {
	type: "function" as const,
	function: { name: "srv_do", description: "do", parameters: { type: "object", properties: {} } },
};

const HOST = [
	"web_search",
	"web_fetch",
	"web_fetch_structured",
	"execute_code",
	"update_plan",
	"remember",
	"artifact",
	"delegate",
	"research",
].map((name) => builtin(name));

function deps(openai: OpenAI, extra: Partial<NestedAgentDeps> = {}): NestedAgentDeps {
	return {
		openai,
		completionBase: { model: "test/model", stream: true, temperature: 0.3, max_tokens: 4000 },
		requestHeaders: { Authorization: "Bearer person-token" },
		servers: [{ name: "srv", url: "https://srv.test/mcp" }],
		mapping: { srv_do: { fnName: "srv_do", server: "srv", tool: "do" } },
		mcpTools: [mcpDef],
		hostBuiltinTools: HOST,
		toolApproval: { policy: "always-allow", approvedTools: new Set() },
		...extra,
	};
}

const MODELS = [
	{ id: "test/model", name: "Test Model" },
	{ id: "other/big", name: "Big One", contextLength: 64_000, maxTokens: 2048 },
];

function make(
	openai: OpenAI,
	options: { research?: boolean; deps?: Partial<NestedAgentDeps> } = {}
): { delegate: NestedAgentBuiltinTool; research?: NestedAgentBuiltinTool } {
	const tools = createDelegateTools({ models: MODELS, research: options.research ?? false });
	for (const tool of tools) tool.bind(deps(openai, options.deps));
	return {
		delegate: tools.find((t) => t.name === "delegate") as NestedAgentBuiltinTool,
		research: tools.find((t) => t.name === "research"),
	};
}

function context(extra: Partial<BuiltinToolContext> = {}) {
	const emitted: MessageSubAgentUpdate[] = [];
	const ctx = {
		uuid: "u1",
		toolCallId: "t1",
		elicitationSink: {
			conversationId: undefined,
			emit: (update: MessageSubAgentUpdate) => emitted.push(update),
		},
		...extra,
	} as unknown as BuiltinToolContext;
	return { ctx, emitted };
}

const BRIEF = "Compare the licences of library A and library B and report the differences.";
const names = (req: Req) => (req.tools ?? []).map((t) => t.function.name).sort();

beforeEach(() => {
	mocks.callMcpTool.mockReset();
	mocks.callMcpTool.mockResolvedValue({ text: "mcp ok", isError: false, content: [] });
});

describe("delegate: the brief", () => {
	it("requires a task, and runs nothing without one", async () => {
		const { openai, create } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		for (const args of [{}, { task: "" }, { task: "  hi  " }, { task: 42 }]) {
			const result = await delegate.execute(args as Record<string, unknown>, context().ctx);
			expect(result).toMatchObject({ error: expect.stringContaining("task") });
		}
		expect(create).not.toHaveBeenCalled();
	});

	it("starts the sub-agent's system prompt with the administrator's instructions", async () => {
		admin.text = "ADMIN RULES";
		try {
			const { openai, requests } = upstream([{ content: "answer" }]);
			const { delegate } = make(openai);
			await delegate.execute({ task: BRIEF }, context().ctx);
			expect(
				String(requests[0].messages[0].content).startsWith(
					"Instructions from this deployment's administrator:\nADMIN RULES\nEnd of the administrator's instructions.\n\n"
				)
			).toBe(true);
		} finally {
			admin.text = "";
		}
	});

	it("gives the sub-agent the brief and a fresh context, never this conversation", async () => {
		const { openai, requests } = upstream([{ content: "answer" }]);
		const { delegate } = make(openai);
		await delegate.execute({ task: BRIEF }, context().ctx);
		expect(requests[0].messages.map((m) => m.role)).toEqual(["system", "user"]);
		expect(requests[0].messages[1].content).toBe(BRIEF);
	});

	it("returns only the sub-agent's final answer", async () => {
		const { openai } = upstream([
			{ content: "thinking out loud", calls: [{ name: "web_search", args: { query: "q" } }] },
			{ content: "The final answer." },
		]);
		const { delegate } = make(openai);
		const result = await delegate.execute({ task: BRIEF }, context().ctx);
		expect(result).toEqual({ resultText: "The final answer." });
	});

	it("lists pages the sub-agent read when its answer does not cite them", async () => {
		const { openai } = upstream([
			{ calls: [{ name: "web_fetch", args: { url: "https://a.test/page" } }] },
			{ content: "It says X." },
		]);
		const { delegate } = make(openai);
		const result = await delegate.execute({ task: BRIEF }, context().ctx);
		expect(result).toMatchObject({
			resultText: expect.stringContaining("Pages the sub-agent read:\n- https://a.test/page"),
		});
	});

	it("does not repeat a source the answer already cites", async () => {
		const { openai } = upstream([
			{ calls: [{ name: "web_fetch", args: { url: "https://a.test/page" } }] },
			{ content: "It says X (https://a.test/page)." },
		]);
		const { delegate } = make(openai);
		const result = await delegate.execute({ task: BRIEF }, context().ctx);
		expect(result).toEqual({ resultText: "It says X (https://a.test/page)." });
	});
});

describe("delegate: tools", () => {
	it("defaults to the server-side tools: web tools and connectors, never code, plan, memory, artifacts or delegation", async () => {
		const { openai, requests } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		await delegate.execute({ task: BRIEF }, context().ctx);
		expect(names(requests[0])).toEqual([
			"srv_do",
			"web_fetch",
			"web_fetch_structured",
			"web_search",
		]);
	});

	it("narrows to the subset asked for", async () => {
		const { openai, requests } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		await delegate.execute({ task: BRIEF, tools: ["web_search"] }, context().ctx);
		expect(names(requests[0])).toEqual(["web_search"]);
	});

	it("drops what a sub-agent may not use, and says so", async () => {
		const { openai, requests } = upstream([{ content: "answer" }]);
		const { delegate } = make(openai);
		const result = await delegate.execute(
			{ task: BRIEF, tools: ["web_search", "execute_code", "delegate", "update_plan", "nope"] },
			context().ctx
		);
		expect(names(requests[0])).toEqual(["web_search"]);
		expect(result).toMatchObject({
			resultText: expect.stringMatching(/Left out.*execute_code, delegate, update_plan, nope/),
		});
	});

	it("is an error when none of the requested tools can be used", async () => {
		const { openai, create } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		const result = await delegate.execute(
			{ task: BRIEF, tools: ["execute_code", "delegate"] },
			context().ctx
		);
		expect(result).toMatchObject({ error: expect.stringContaining("web_search") });
		expect(create).not.toHaveBeenCalled();
	});

	it("is an error when the chat offers no tool a sub-agent could use", async () => {
		const { openai, create } = upstream([{ content: "x" }]);
		const { delegate } = make(openai, {
			deps: { hostBuiltinTools: [builtin("update_plan")], mcpTools: [] },
		});
		const result = await delegate.execute({ task: BRIEF }, context().ctx);
		expect(result).toMatchObject({ error: expect.stringContaining("No tools") });
		expect(create).not.toHaveBeenCalled();
	});

	it("a sub-agent that calls delegate anyway is refused: depth is one", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "delegate", args: { task: "go deeper please" } }] },
			{ content: "ok" },
		]);
		const { delegate } = make(openai);
		await delegate.execute({ task: BRIEF }, context().ctx);
		expect(requests).toHaveLength(2);
		expect(requests[1].messages.find((m) => m.role === "tool")?.content).toContain("not available");
	});
});

describe("delegate: the model", () => {
	it("defaults to the conversation's model with its sampling", async () => {
		const { openai, requests } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		await delegate.execute({ task: BRIEF }, context().ctx);
		expect(requests[0]).toMatchObject({ model: "test/model", temperature: 0.3, max_tokens: 4000 });
	});

	it("runs on another model from the person's list, with that model's own caps and none of the main model's sampling", async () => {
		const { openai, requests } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		const { ctx, emitted } = context();
		await delegate.execute({ task: BRIEF, model: "other/big" }, ctx);
		expect(requests[0].model).toBe("other/big");
		expect(requests[0].max_tokens).toBe(2048);
		expect(requests[0].temperature).toBeUndefined();
		expect(emitted.at(-1)?.model).toBe("Big One");
	});

	it("refuses a model that is not in the person's list, and runs nothing", async () => {
		const { openai, create } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		const result = await delegate.execute({ task: BRIEF, model: "secret/model" }, context().ctx);
		expect(result).toMatchObject({ error: expect.stringContaining("secret/model") });
		expect(result).toMatchObject({ error: expect.stringContaining("other/big") });
		expect(create).not.toHaveBeenCalled();
	});

	it("never accepts a custom model id, whatever the list holds", async () => {
		const { openai, create } = upstream([{ content: "x" }]);
		const tools = createDelegateTools({
			models: [...MODELS, { id: "custom:0123456789abcdef01234567", name: "Mine" }],
			research: false,
		});
		tools[0].bind(deps(openai));
		const result = await tools[0].execute(
			{ task: BRIEF, model: "custom:0123456789abcdef01234567" },
			context().ctx
		);
		expect(result).toMatchObject({ error: expect.stringContaining("custom model") });
		expect(create).not.toHaveBeenCalled();
	});

	it("names the models it accepts in its definition", () => {
		const [delegate] = createDelegateTools({ models: MODELS, research: false });
		const props = (
			delegate.definition.function.parameters as {
				properties: Record<string, { description: string }>;
			}
		).properties;
		expect(props.model.description).toContain("other/big");
	});
});

describe("delegate: running several at once", () => {
	it("runs three together and refuses a fourth with a clear message", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { openai, create } = upstream([{ content: "done", wait: gate }]);
		const { delegate } = make(openai);

		const runs = [1, 2, 3].map((n) =>
			delegate.execute({ task: `${BRIEF} (${n})` }, context({ uuid: `u${n}` }).ctx)
		);
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(MAX_PARALLEL_SUBAGENTS));

		const fourth = await delegate.execute({ task: `${BRIEF} (4)` }, context({ uuid: "u4" }).ctx);
		expect(fourth).toMatchObject({ error: expect.stringContaining("At most 3") });
		expect(create).toHaveBeenCalledTimes(MAX_PARALLEL_SUBAGENTS);

		release();
		const results = await Promise.all(runs);
		expect(results.every((r) => "resultText" in r)).toBe(true);
	});

	it("frees a slot when a sub-agent finishes or fails", async () => {
		const { openai } = upstream([{ content: "ok" }]);
		const { delegate } = make(openai);
		for (let i = 0; i < MAX_PARALLEL_SUBAGENTS + 2; i += 1) {
			const result = await delegate.execute({ task: `${BRIEF} ${i}` }, context().ctx);
			expect(result).toMatchObject({ resultText: "ok" });
		}
	});

	it("refuses an eleventh sub-agent in one turn, however they were spaced", async () => {
		const { openai, create } = upstream([{ content: "ok" }]);
		const { delegate, research } = make(openai, { research: true });
		for (let i = 0; i < MAX_SUBAGENTS_PER_TURN; i += 1) {
			const run =
				i % 2 === 0
					? delegate.execute({ task: `${BRIEF} ${i}` }, context().ctx)
					: research?.execute({ question: `Question number ${i}?` }, context().ctx);
			expect(await run).toMatchObject({ resultText: "ok" });
		}
		const calls = create.mock.calls.length;
		const eleventh = await delegate.execute({ task: `${BRIEF} last` }, context().ctx);
		expect(eleventh).toMatchObject({
			error: expect.stringContaining(`${MAX_SUBAGENTS_PER_TURN} sub-agents`),
		});
		expect(create.mock.calls.length).toBe(calls);
	});

	it("counts research agents against the same three", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		const { openai, create } = upstream([{ content: "done", wait: gate }]);
		const { delegate, research } = make(openai, { research: true });
		const runs = [
			research?.execute({ question: "What is the capital of Australia?" }, context().ctx),
			delegate.execute({ task: BRIEF }, context().ctx),
			delegate.execute({ task: `${BRIEF} again` }, context().ctx),
		];
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
		const refused = await research?.execute(
			{ question: "What is the capital of France?" },
			context().ctx
		);
		expect(refused).toMatchObject({ error: expect.stringContaining("At most 3") });
		release();
		await Promise.all(runs);
	});
});

describe("delegate: limits and stopping", () => {
	it("carries the limits it advertises", () => {
		expect(SUBAGENT_MAX_STEPS).toBe(25);
		expect(SUBAGENT_TOKEN_BUDGET).toBeGreaterThan(0);
		expect(SUBAGENT_TIMEOUT_MS).toBeGreaterThan(0);
	});

	it("stops after its steps and answers without tools (25 rounds, then a summary)", async () => {
		const loop = Array.from({ length: SUBAGENT_MAX_STEPS }, (_, i) => ({
			calls: [{ name: "web_search", args: { query: `q${i}` } }],
		}));
		const { openai, requests } = upstream([...loop, { content: "what I have" }]);
		const { delegate } = make(openai);
		const result = await delegate.execute({ task: BRIEF }, context().ctx);
		expect(result).toEqual({ resultText: "what I have" });
		expect(requests).toHaveLength(SUBAGENT_MAX_STEPS + 1);
		expect(requests.at(-1)?.tools).toBeUndefined();
	});

	it("Stop cancels every sub-agent running, and each card says stopped", async () => {
		const controller = new AbortController();
		const never = new Promise<void>(() => undefined);
		const create = vi.fn(
			(_req: Req, opts: { signal?: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
					void never;
				})
		);
		const openai = { chat: { completions: { create } } } as unknown as OpenAI;
		const { delegate } = make(openai);
		const a = context({ uuid: "a", abortSignal: controller.signal });
		const b = context({ uuid: "b", abortSignal: controller.signal });
		const runs = [
			delegate.execute({ task: BRIEF }, a.ctx),
			delegate.execute({ task: `${BRIEF} too` }, b.ctx),
		];
		await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
		controller.abort();
		const results = await Promise.all(runs);
		expect(results).toEqual([{ error: "Aborted by user" }, { error: "Aborted by user" }]);
		expect(a.emitted.at(-1)?.status).toBe("stopped");
		expect(b.emitted.at(-1)?.status).toBe("stopped");
	});
});

describe("delegate: the chat's own tools", () => {
	it("runs the chat's own tool instances, so per-turn caps (fetches, searches) hold across sub-agents", async () => {
		let uses = 0;
		const fetchTool: BuiltinTool = {
			...builtin("web_fetch"),
			execute: async () => {
				uses += 1;
				return { resultText: `page ${uses}` };
			},
		};
		const { openai } = upstream([
			{ calls: [{ name: "web_fetch", args: { url: "https://a.test/x" } }] },
			{ content: "done" },
			{ calls: [{ name: "web_fetch", args: { url: "https://a.test/y" } }] },
			{ content: "done again" },
		]);
		const { delegate } = make(openai, {
			deps: { hostBuiltinTools: [...HOST.filter((t) => t.name !== "web_fetch"), fetchTool] },
		});
		await delegate.execute({ task: BRIEF }, context().ctx);
		await delegate.execute({ task: `${BRIEF} again` }, context().ctx);
		expect(uses).toBe(2);
	});
});

describe("delegate: approvals", () => {
	it("a sub-agent never runs an MCP tool the person would have been asked about", async () => {
		const { openai } = upstream([
			{ calls: [{ name: "srv_do", args: {} }] },
			{ content: "I could not use it." },
		]);
		const { delegate } = make(openai, {
			deps: { toolApproval: { policy: "manual", approvedTools: new Set() } },
		});
		const { ctx, emitted } = context();
		const result = await delegate.execute({ task: BRIEF, tools: ["srv_do"] }, ctx);
		expect(mocks.callMcpTool).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			resultText: expect.stringContaining("could not use srv:do"),
		});
		expect(emitted.at(-1)?.steps).toEqual([
			expect.objectContaining({ tool: "srv_do", outcome: "refused" }),
		]);
	});

	it("uses the same tool once the conversation has approved it", async () => {
		const { openai } = upstream([{ calls: [{ name: "srv_do", args: {} }] }, { content: "done" }]);
		const { delegate } = make(openai, {
			deps: { toolApproval: { policy: "manual", approvedTools: new Set(["srv:do"]) } },
		});
		await delegate.execute({ task: BRIEF, tools: ["srv_do"] }, context().ctx);
		expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
	});
});

describe("delegate: the card's state", () => {
	it("starts running with its title and model, shows the current step, and ends done", async () => {
		const { openai } = upstream([
			{ calls: [{ name: "web_search", args: { query: "licence of A" } }] },
			{ content: "done" },
		]);
		const { delegate } = make(openai);
		const { ctx, emitted } = context();
		await delegate.execute({ task: BRIEF, title: "Compare licences" }, ctx);

		expect(emitted[0]).toMatchObject({
			uuid: "u1",
			title: "Compare licences",
			model: "Test Model",
			status: "running",
			steps: [],
		});
		const live = emitted.find((u) => u.activity?.startsWith("searching"));
		expect(live?.activity).toBe("searching “licence of A”");
		expect(live?.steps[0]).toMatchObject({ tool: "web_search", outcome: "running" });
		expect(emitted.at(-1)).toMatchObject({
			status: "done",
			steps: [{ tool: "web_search", label: "search “licence of A”", outcome: "ok" }],
		});
		expect(emitted.at(-1)?.activity).toBeUndefined();
	});

	it("derives a title from the brief when none is given", async () => {
		const { openai } = upstream([{ content: "x" }]);
		const { delegate } = make(openai);
		const { ctx, emitted } = context();
		await delegate.execute({ task: BRIEF }, ctx);
		expect(emitted[0].title).toBe(deriveTitle(BRIEF));
		expect(emitted[0].title.length).toBeLessThanOrEqual(48);
	});

	it("ends failed when the sub-agent produces nothing", async () => {
		const { openai } = upstream([{ content: "" }]);
		const { delegate } = make(openai);
		const { ctx, emitted } = context();
		const result = await delegate.execute({ task: BRIEF }, ctx);
		expect(result).toMatchObject({ error: expect.any(String) });
		expect(emitted.at(-1)?.status).toBe("failed");
	});

	it("describes calls in words", () => {
		expect(describeCall("web_fetch", JSON.stringify({ url: "https://a.test/docs/x" }))).toEqual({
			activity: "reading a.test/docs/x",
			label: "read a.test/docs/x",
		});
		expect(describeCall("srv_do", "{}").activity).toBe("calling srv_do");
	});
});

describe("the research preset", () => {
	it("is offered only where web search is", () => {
		expect(createDelegateTools({ models: [], research: false }).map((t) => t.name)).toEqual([
			"delegate",
		]);
		expect(createDelegateTools({ models: [], research: true }).map((t) => t.name)).toEqual([
			"delegate",
			"research",
		]);
	});

	it("uses the web and nothing else, even when connectors and other tools are offered", async () => {
		const { openai, requests } = upstream([{ content: "x" }]);
		const { research } = make(openai, { research: true });
		await research?.execute({ question: "How does X work compared with Y?" }, context().ctx);
		expect(names(requests[0])).toEqual(["web_fetch", "web_fetch_structured", "web_search"]);
	});

	it("runs with the fixed research prompt and the question as the brief", async () => {
		const { openai, requests } = upstream([{ content: "x" }]);
		const { research } = make(openai, { research: true });
		const { ctx, emitted } = context();
		await research?.execute({ question: "How does X work compared with Y?" }, ctx);
		expect(requests[0].messages[0].content).toBe(RESEARCH_SYSTEM_PROMPT);
		expect(requests[0].messages[1].content).toBe("How does X work compared with Y?");
		expect(emitted[0].preset).toBe("research");
	});

	it("lead the research agent's system prompt with the administrator's instructions", async () => {
		admin.text = "ADMIN RULES";
		try {
			const { openai, requests } = upstream([{ content: "x" }]);
			const { research } = make(openai, { research: true });
			await research?.execute({ question: "How does X work compared with Y?" }, context().ctx);
			expect(requests[0].messages[0].content).toBe(
				`Instructions from this deployment's administrator:\nADMIN RULES\nEnd of the administrator's instructions.\n\n${RESEARCH_SYSTEM_PROMPT}`
			);
		} finally {
			admin.text = "";
		}
	});

	it("has a general research prompt: plan, primary sources, cross-check, cite, say where sources disagree or are thin, web only", () => {
		for (const part of [
			/Plan first/,
			/primary sources/,
			/Cross-check/,
			/Cite each claim/,
			/sources disagree/,
			/thin/,
		]) {
			expect(RESEARCH_SYSTEM_PROMPT).toMatch(part);
		}
		expect(RESEARCH_SYSTEM_PROMPT).not.toMatch(/github|hugging ?face|dataset|trackio/i);
	});

	it("needs a question, and a chat that can search", async () => {
		const { openai, create } = upstream([{ content: "x" }]);
		const { research } = make(openai, { research: true });
		expect(await research?.execute({}, context().ctx)).toMatchObject({
			error: expect.stringContaining("question"),
		});
		const { research: bare } = make(openai, {
			research: true,
			deps: { hostBuiltinTools: [builtin("update_plan")] },
		});
		expect(
			await bare?.execute({ question: "What is the capital of Australia?" }, context().ctx)
		).toMatchObject({ error: expect.stringContaining("Web search is not available") });
		expect(create).not.toHaveBeenCalled();
	});

	it("takes no model argument: it runs on the conversation's model", () => {
		const research = createDelegateTools({ models: MODELS, research: true })[1];
		const props = (research.definition.function.parameters as { properties: object }).properties;
		expect(Object.keys(props)).toEqual(["question", "title"]);
	});
});

describe("an unbound tool", () => {
	it("says sub-agents are not available rather than running with nothing", async () => {
		const [delegate] = createDelegateTools({ models: [], research: false });
		expect(await delegate.execute({ task: BRIEF }, context().ctx)).toMatchObject({
			error: expect.stringContaining("not available"),
		});
	});
});
