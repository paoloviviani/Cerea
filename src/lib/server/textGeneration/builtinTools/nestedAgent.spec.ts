import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenAI } from "openai";

const mocks = vi.hoisted(() => ({
	callMcpTool: vi.fn(),
}));

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

const { runNestedAgent, createSubAgentApprovalGuard, APPROVAL_REFUSAL_PREFIX } =
	await import("./nestedAgent");
import type { NestedAgentDeps, NestedAgentObserver, NestedAgentSpec } from "./nestedAgent";
import type { BuiltinTool } from "./types";

type Req = {
	stream?: boolean;
	model?: string;
	messages: Array<{ role: string; content?: string | null }>;
	tools?: Array<{ function: { name: string } }>;
};
type Opts = { signal?: AbortSignal; headers?: Record<string, string> };
type Reply = {
	content?: string | null;
	calls?: Array<{ name: string; args?: object }>;
	tokens?: number;
};

/** An upstream that answers from a script, recording every request and its options. */
function upstream(script: Array<Reply | ((req: Req, opts: Opts) => Promise<Reply>)>) {
	const requests: Array<{ req: Req; opts: Opts }> = [];
	let next = 0;
	const create = vi.fn(async (req: Req, opts: Opts) => {
		// The tool list is copied: a sub-agent that loads connectors appends to it in place.
		requests.push({ req: { ...req, tools: req.tools ? [...req.tools] : undefined }, opts });
		const step = script[Math.min(next, script.length - 1)];
		next += 1;
		const reply = typeof step === "function" ? await step(req, opts) : step;
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
			usage: { total_tokens: reply.tokens ?? 10 },
		};
	});
	return { openai: { chat: { completions: { create } } } as unknown as OpenAI, requests, create };
}

const searchTool = (): BuiltinTool => ({
	name: "web_search",
	definition: {
		type: "function",
		function: { name: "web_search", description: "search", parameters: { type: "object" } },
	},
	execute: async () => ({ resultText: "result: found it" }),
});

const mcpDef = {
	type: "function" as const,
	function: { name: "srv_do", description: "do", parameters: { type: "object", properties: {} } },
};

function deps(openai: OpenAI, extra: Partial<NestedAgentDeps> = {}): NestedAgentDeps {
	return {
		openai,
		completionBase: { model: "test/model", stream: true },
		requestHeaders: { Authorization: "Bearer person-token", "ChatUI-Conversation-ID": "c1" },
		servers: [{ name: "srv", url: "https://srv.test/mcp" }],
		mapping: { srv_do: { fnName: "srv_do", server: "srv", tool: "do" } },
		mcpTools: [mcpDef],
		hostBuiltinTools: [searchTool()],
		...extra,
	};
}

function spec(extra: Partial<NestedAgentSpec> = {}): NestedAgentSpec {
	return {
		label: "delegate",
		displayName: "Sub-agent",
		systemPrompt: "system",
		task: "the brief",
		allowedTools: new Set(["web_search", "srv_do"]),
		maxIterations: 5,
		truncateOutput: (text) => text,
		stop: {
			contextWarn: "warn",
			contextMax: "ctx-max",
			iterationLimit: "iteration-limit",
			repetition: "repetition",
			budget: "budget-spent",
			timeLimit: "time-up",
		},
		failure: {
			noTools: "no tools",
			contextMax: "ctx failure",
			iterationLimit: "iteration failure",
			noSummary: "no summary",
			rateLimited: "rate limited",
		},
		progress: { start: "start", done: "done" },
		...extra,
	};
}

const ctx = (extra: Record<string, unknown> = {}) => ({ uuid: "u1", toolCallId: "t1", ...extra });
const toolNames = (req: Req) => (req.tools ?? []).map((tool) => tool.function.name);

beforeEach(() => {
	mocks.callMcpTool.mockReset();
	mocks.callMcpTool.mockResolvedValue({ text: "mcp ok", isError: false, content: [] });
});

describe("a sub-agent run", () => {
	it("returns only the final answer, and reports each step to its observer", async () => {
		const { openai } = upstream([
			{ content: "let me look", calls: [{ name: "web_search", args: { query: "cats" } }] },
			{ content: "The answer is 42." },
		]);
		const events: string[] = [];
		const observer: NestedAgentObserver = {
			calling: (calls) => events.push(`calling:${calls.map((c) => c.name).join(",")}`),
			step: (step) => events.push(`step:${step.name}:${step.outcome}`),
		};
		const result = await runNestedAgent(spec({ observer }), ctx(), deps(openai));

		expect(result).toEqual({ resultText: "The answer is 42." });
		expect(events).toEqual(["calling:web_search", "step:web_search:ok"]);
	});

	it("starts from a fresh context: the system prompt and the brief, nothing else", async () => {
		const { openai, requests } = upstream([{ content: "ok" }]);
		await runNestedAgent(spec(), ctx(), deps(openai));
		expect(requests[0].req.messages.map((m) => [m.role, m.content])).toEqual([
			["system", "system"],
			["user", "the brief"],
		]);
	});

	it("sends the person's own token and conversation header on every request (billing)", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "web_search", args: { query: "x" } }] },
			{ content: "done" },
		]);
		await runNestedAgent(spec(), ctx(), deps(openai));
		expect(requests).toHaveLength(2);
		for (const { opts } of requests) {
			expect(opts.headers).toMatchObject({
				Authorization: "Bearer person-token",
				"ChatUI-Conversation-ID": "c1",
			});
		}
	});

	it("offers the model only the allowlisted tools", async () => {
		const { openai, requests } = upstream([{ content: "ok" }]);
		await runNestedAgent(
			spec({ allowedTools: new Set(["web_search"]) }),
			ctx(),
			deps(openai, { hostBuiltinTools: [searchTool(), { ...searchTool(), name: "execute_code" }] })
		);
		expect(toolNames(requests[0].req)).toEqual(["web_search"]);
	});

	it("refuses a tool outside the allowlist that the model calls anyway", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "delegate", args: { task: "again" } }] },
			{ content: "fine" },
		]);
		const steps: string[] = [];
		await runNestedAgent(
			spec({ observer: { step: (s) => steps.push(`${s.name}:${s.outcome}`) } }),
			ctx(),
			deps(openai)
		);
		const refusal = requests[1].req.messages.find((m) => m.role === "tool");
		expect(refusal?.content).toContain("not available");
		expect(steps).toEqual(["delegate:refused"]);
	});
});

describe("connectors loaded by a sub-agent (ADR 0104)", () => {
	// A stand-in for the turn's runtime: loading changes the turn's own lists in place and bumps
	// `version`, which is how a sub-agent finds out.
	function loader(d: NestedAgentDeps) {
		const state = { version: 0 };
		d.connectors = state;
		const loadTools: BuiltinTool = {
			name: "load_tools",
			definition: {
				type: "function",
				function: { name: "load_tools", parameters: { type: "object" } },
			},
			execute: async () => {
				d.servers.push({ name: "maps", url: "https://maps.test/mcp" });
				d.mapping.maps_find = { fnName: "maps_find", server: "maps", tool: "find" };
				d.mcpTools.push({
					type: "function",
					function: { name: "maps_find", parameters: { type: "object" } },
				});
				state.version += 1;
				return { resultText: "Loaded maps." };
			},
		};
		d.hostBuiltinTools.push(loadTools);
	}

	it("offers what it loaded on its next request, after the tools it started with", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "load_tools", args: { connectors: ["maps"] } }] },
			{ content: "done" },
		]);
		const d = deps(openai);
		loader(d);
		await runNestedAgent(
			spec({ allowedTools: new Set(["web_search", "srv_do", "load_tools"]) }),
			ctx(),
			d
		);
		expect(toolNames(requests[0].req)).not.toContain("maps_find");
		const second = toolNames(requests[1].req);
		expect(second).toContain("maps_find");
		expect(second.slice(0, toolNames(requests[0].req).length)).toEqual(toolNames(requests[0].req));
	});

	it("does not offer what was loaded to an agent that may not load", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "web_search", args: { query: "x" } }] },
			{ content: "done" },
		]);
		const d = deps(openai);
		loader(d);
		// Another agent (the main turn) loads between this agent's requests.
		d.hostBuiltinTools[0].execute = async () => {
			d.connectors = { version: 1 };
			d.mcpTools.push({ type: "function", function: { name: "maps_find" } });
			return { resultText: "found" };
		};
		await runNestedAgent(spec(), ctx(), d);
		expect(toolNames(requests[1].req)).not.toContain("maps_find");
	});
});

describe("approvals inside a sub-agent", () => {
	const callsMcp = () => upstream([{ calls: [{ name: "srv_do", args: {} }] }, { content: "done" }]);

	it("refuses an MCP tool the conversation has not approved, and never dispatches it", async () => {
		const { openai, requests } = callsMcp();
		const steps: Array<{ outcome: string; error?: string }> = [];
		const result = await runNestedAgent(
			spec({ observer: { step: (s) => steps.push(s) } }),
			ctx(),
			deps(openai, { toolApproval: { policy: "manual", approvedTools: new Set() } })
		);
		expect(mocks.callMcpTool).not.toHaveBeenCalled();
		const message = requests[1].req.messages.find((m) => m.role === "tool")?.content ?? "";
		expect(message).toContain(APPROVAL_REFUSAL_PREFIX);
		expect(message).toContain("srv:do");
		expect(steps[0].outcome).toBe("refused");
		expect(result).toEqual({ resultText: "done" });
	});

	it("fails closed when the caller passes no approval state at all", async () => {
		const { openai } = callsMcp();
		await runNestedAgent(spec(), ctx(), deps(openai));
		expect(mocks.callMcpTool).not.toHaveBeenCalled();
	});

	it("runs a tool the conversation already approved", async () => {
		const { openai } = callsMcp();
		await runNestedAgent(
			spec(),
			ctx(),
			deps(openai, { toolApproval: { policy: "manual", approvedTools: new Set(["srv:do"]) } })
		);
		expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
	});

	it("runs any MCP tool under the always-allow policy, as the main chat would", async () => {
		const { openai } = callsMcp();
		await runNestedAgent(
			spec(),
			ctx(),
			deps(openai, { toolApproval: { policy: "always-allow", approvedTools: new Set() } })
		);
		expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
	});

	it("the guard names the qualified tool and tells the model not to retry", async () => {
		const guard = createSubAgentApprovalGuard(
			{ srv_do: { fnName: "srv_do", server: "srv", tool: "do" } },
			{ policy: "manual", approvedTools: new Set() }
		);
		const verdict = await guard.before({
			serverUrl: "u",
			tool: "do",
			fnName: "srv_do",
			args: {},
			callUuid: "x",
		});
		expect(verdict).toMatchObject({ allow: false });
		expect("message" in verdict && verdict.message).toMatch(/Do not retry/);
		expect(guard.allowParking).toBe(false);
	});
});

describe("a sub-agent's limits", () => {
	it("stops after maxIterations and answers from what it has, without tools", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "web_search", args: { query: "a" } }] },
			{ calls: [{ name: "web_search", args: { query: "b" } }] },
			{ content: "partial answer" },
		]);
		const result = await runNestedAgent(spec({ maxIterations: 2 }), ctx(), deps(openai));
		expect(result).toEqual({ resultText: "partial answer" });
		const last = requests.at(-1)?.req;
		expect(last?.tools).toBeUndefined();
		expect(last?.messages.at(-1)?.content).toBe("iteration-limit");
	});

	it("stops when the tokens it spent in total pass the budget, even though no one request is large", async () => {
		const { openai, requests } = upstream([
			{ calls: [{ name: "web_search", args: { query: "a" } }], tokens: 60 },
			{ calls: [{ name: "web_search", args: { query: "b" } }], tokens: 60 },
			{ content: "budget answer" },
		]);
		const result = await runNestedAgent(spec({ maxTotalTokens: 100 }), ctx(), deps(openai));
		expect(result).toEqual({ resultText: "budget answer" });
		// two working requests (60 + 60 > 100), then the forced summary
		expect(requests).toHaveLength(3);
		expect(requests[2].req.tools).toBeUndefined();
		expect(requests[2].req.messages.at(-1)?.content).toBe("budget-spent");
	});

	it("stops at the wall-clock limit, cancels the request in flight, and still answers", async () => {
		let firstSignal: AbortSignal | undefined;
		const { openai, requests } = upstream([
			async (_req, opts) => {
				firstSignal = opts.signal;
				await new Promise((resolve, reject) => {
					opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
						once: true,
					});
					setTimeout(resolve, 5_000);
				});
				return { content: "never" };
			},
			{ content: "out of time answer" },
		]);
		const result = await runNestedAgent(spec({ deadlineMs: 40 }), ctx(), deps(openai));
		expect(result).toEqual({ resultText: "out of time answer" });
		expect(firstSignal?.aborted).toBe(true);
		expect(requests.at(-1)?.req.messages.at(-1)?.content).toBe("time-up");
		// the summary is not cancelled by the deadline that ended the work
		expect(requests.at(-1)?.opts.signal?.aborted).toBeFalsy();
	});
});

describe("cancelling a sub-agent", () => {
	it("Stop ends the run with no summary request", async () => {
		const controller = new AbortController();
		const { openai, requests } = upstream([
			async (_req, opts) => {
				queueMicrotask(() => controller.abort());
				await new Promise((_resolve, reject) =>
					opts.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
				);
				return {};
			},
		]);
		const result = await runNestedAgent(
			spec(),
			ctx({ abortSignal: controller.signal }),
			deps(openai)
		);
		expect(result).toEqual({ error: "Aborted by user" });
		expect(requests).toHaveLength(1);
	});

	it("a signal already aborted does no work", async () => {
		const controller = new AbortController();
		controller.abort();
		const { openai, create } = upstream([{ content: "x" }]);
		const result = await runNestedAgent(
			spec(),
			ctx({ abortSignal: controller.signal }),
			deps(openai)
		);
		expect(result).toEqual({ error: "Aborted by user" });
		expect(create).not.toHaveBeenCalled();
	});
});
