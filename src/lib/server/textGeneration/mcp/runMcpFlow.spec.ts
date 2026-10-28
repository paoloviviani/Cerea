import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { rememberTools, resetCatalogCache } from "$lib/server/mcp/catalogCache";
import {
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { RETRY_BACKOFF_MS } from "$lib/server/textGeneration/utils/upstreamRetry";
import { APIConnectionError } from "openai";
import type { McpFlowResult, RunMcpFlowContext } from "./runMcpFlow";

// ---------------------------------------------------------------------------
// Harness
//
// runMcpFlow reaches a long way out — the router, the MCP registry, the OpenAI
// SDK, tool execution — so nothing in it was reachable from a test. Everything
// below stubs those edges and leaves the flow itself real, so a test can script
// what the upstream returns and assert on what the flow does with it.
//
// The `vi.mock` calls have to live in the spec file (they are hoisted per
// module), so extracting this into a fixture would only move the builders.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
	/** The servers each tool listing was asked about, newest last. */
	listedServers: [] as string[][],
	/** The tool names each upstream request carried, as they were when it was sent. */
	sentTools: [] as string[][],
	/** When set, replaces the fixed tool listing (see the connectors-on-demand tests). */
	listTools: undefined as
		| undefined
		| ((servers: { name: string }[]) => {
				tools: unknown[];
				mapping: Record<string, unknown>;
				unavailable: unknown[];
		  }),
	create: vi.fn(),
	executeToolCalls: vi.fn(),
	getAbortTime: vi.fn(() => undefined as number | undefined),
	// Mutable so a test can strip the MCP tools.
	mcpTools: [{ type: "function", function: { name: "do_thing" } }] as Array<{
		type: string;
		function: { name: string };
	}>,
	// Every isMultimodal value the flow passed to message preparation, in order.
	multimodalFlags: [] as Array<unknown>,
	servers: [{ name: "hf", url: "https://example.test/mcp" }] as Array<{
		name: string;
		url: string;
	}>,
	// The deployment's execute_code flag, readable per test: "true" mirrors the
	// live deployment (where the recovery path is reachable), "false" pins the
	// flag-off behavior.
	codeToolEnabled: "true",
	// The ask_user_question deployment switch: undefined means on, "false" off.
	askQuestionEnabled: undefined as string | undefined,
	// Servers whose tool listing failed this turn, as `getOpenAiToolsForMcp` reports them.
	unlisted: [] as Array<{ name: string; reason: string }>,
	// The sub-agent switch (CHAT_DELEGATION): "false" off, anything else on. Off by
	// default in this file so the tool lists below stay about what they test.
	delegation: "false" as string | undefined,
	// The models the signed-in person may pick for a sub-agent.
	visible: [] as Array<Record<string, unknown>>,
	useUserToken: "false",
	// Web search grants, as `resolveWebSearchFor` reports them.
	searchGranted: [] as string[],
	// What the document service reports (`getCapabilities`); null is "not configured".
	documentCaps: null as unknown,
}));

vi.mock("$lib/server/documents/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/documents/client")>()),
	getCapabilities: async () => mocks.documentCaps,
}));

// The gate itself is real; only the build flag behind it is forced on.

// Only the client is stubbed. The SDK's error classes stay real: the retry
// predicate identifies a dead connection by class, so a mocked-away
// APIConnectionError would make every upstream failure unrecognizable.
vi.mock("openai", async (importOriginal) => ({
	...(await importOriginal<typeof import("openai")>()),
	OpenAI: class {
		chat = { completions: { create: mocks.create } };
	},
}));

vi.mock("$lib/server/config", () => ({
	config: {
		getSaved: () => undefined,
		OPENAI_BASE_URL: "https://router.test/v1",
		OPENAI_API_KEY: "sk-test",
		MCP_FORWARD_HF_USER_TOKEN: "false",
		EXA_API_KEY: "",
		get USE_USER_TOKEN() {
			return mocks.useUserToken;
		},
		// A getter, not a value: the flag is a per-test switch (see
		// mocks.codeToolEnabled), and the mocked config object is shared.
		get CHAT_CODE_TOOL_ENABLED() {
			return mocks.codeToolEnabled;
		},
		get CHAT_ASK_USER_QUESTION_ENABLED() {
			return mocks.askQuestionEnabled;
		},
		get CHAT_DELEGATION() {
			return mocks.delegation;
		},
	},
}));

vi.mock("$lib/server/mcp/registry", () => ({
	getMcpServers: () => mocks.servers,
}));

vi.mock("$lib/server/urlSafety", () => ({ isValidUrl: () => true }));

vi.mock("$lib/server/visibleModels", () => ({ visibleModels: async () => mocks.visible }));

vi.mock("$lib/server/webSearch/config", () => ({
	resolveWebSearchFor: async () => ({ granted: mocks.searchGranted, model: null }),
}));

vi.mock("$lib/server/mcp/tools", () => ({
	sanitizeName: (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64),
	getOpenAiToolsForMcp: async (servers: { name: string }[]) => {
		mocks.listedServers.push(servers.map((s) => s.name));
		if (mocks.listTools) return mocks.listTools(servers);
		return servers.length === 0
			? { tools: [], mapping: {}, unavailable: [] }
			: {
					tools: mocks.mcpTools,
					mapping: { do_thing: { fnName: "do_thing", server: "hf", tool: "do_thing" } },
					unavailable: mocks.unlisted,
				};
	},
}));

vi.mock("./toolInvocation", () => ({ executeToolCalls: mocks.executeToolCalls }));

vi.mock("$lib/server/textGeneration/utils/prepareFiles", () => ({
	prepareMessagesWithFiles: async (
		messages: Array<{ from: string; content: string }>,
		_processor: unknown,
		isMultimodal: unknown
	) => {
		mocks.multimodalFlags.push(isMultimodal);
		return messages.map((m) => ({ role: m.from, content: m.content }));
	},
}));

vi.mock("$lib/server/endpoints/images", () => ({ makeImageProcessor: () => () => undefined }));
vi.mock("./fileRefs", () => ({
	buildImageRefResolver: () => undefined,
	attachFileRefsToArgs: () => undefined,
}));
vi.mock("$lib/server/logger", () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("$lib/server/abortedGenerations", () => ({
	AbortedGenerations: { getInstance: () => ({ getAbortTime: mocks.getAbortTime }) },
}));

const { runMcpFlow } = await import("./runMcpFlow");

type ScriptedCall = { id?: string; name?: string; arguments: string };

/** One upstream completion: what it streams back, and how it ended. */
type Round = {
	content?: string;
	reasoning?: string;
	toolCalls?: ScriptedCall[];
	/**
	 * Raw delta objects, yielded verbatim before the finish chunk, for rounds
	 * where the ORDER of reasoning/content/tool_calls matters. Overrides the
	 * three fields above.
	 */
	deltas?: Array<Record<string, unknown>>;
	/** Defaults to "tool_calls" when the round emits calls, else "stop". */
	finishReason?: string;
	/** Throw instead of returning a stream, to script an upstream failure. */
	error?: Error;
};

function chunk(choice: Record<string, unknown>) {
	return { choices: [choice] };
}

function streamFor(round: Round) {
	if (round.deltas) {
		const deltas = round.deltas;
		return (async function* () {
			for (const delta of deltas) yield chunk({ delta });
			yield chunk({ delta: {}, finish_reason: round.finishReason ?? "stop" });
		})();
	}
	return (async function* () {
		if (round.reasoning) yield chunk({ delta: { reasoning: round.reasoning } });
		if (round.content) yield chunk({ delta: { content: round.content } });
		for (const [index, call] of (round.toolCalls ?? []).entries()) {
			yield chunk({
				delta: {
					tool_calls: [
						{ index, id: call.id, function: { name: call.name, arguments: call.arguments } },
					],
				},
			});
		}
		yield chunk({
			delta: {},
			finish_reason: round.finishReason ?? (round.toolCalls?.length ? "tool_calls" : "stop"),
		});
	})();
}

/** Queue the upstream responses, in order. A missing round means the flow looped further than scripted. */
function scriptRounds(rounds: Round[]) {
	let next = 0;
	mocks.create.mockImplementation(
		async (request: { tools?: Array<{ function: { name: string } }> }) => {
			// Copied: the flow appends to its tool list in place, and a later round must not rewrite
			// what an earlier request was sent.
			mocks.sentTools.push((request?.tools ?? []).map((tool) => tool.function.name));
			const round = rounds[next++];
			if (!round)
				throw new Error(`upstream called ${next} times but only ${rounds.length} scripted`);
			if (round.error) throw round.error;
			return streamFor(round);
		}
	);
}

/** Make every scripted tool call resolve with `output`. */
function scriptToolResults(output = "tool ok") {
	mocks.executeToolCalls.mockImplementation(async function* ({
		calls,
	}: {
		calls: Array<{ id: string; name: string }>;
	}) {
		for (const call of calls) {
			yield {
				type: "update",
				update: {
					type: MessageUpdateType.Tool,
					subtype: MessageToolUpdateType.Call,
					uuid: call.id,
					call: { name: call.name, parameters: {} },
				},
			};
		}
		yield {
			type: "complete",
			summary: {
				toolMessages: calls.map((call) => ({
					role: "tool" as const,
					tool_call_id: call.id,
					content: output,
				})),
				toolRuns: calls.map((call) => ({ name: call.name, parameters: {}, output })),
			},
		};
	});
}

function context(): RunMcpFlowContext & { abortSignal?: AbortSignal } {
	return {
		// Explicit `false`: this fixture is tool-capable, so it would
		// otherwise default artifacts on (the `supportsTools` fallback) and
		// add the `artifact` tool to every list this file asserts — noise for
		// specs about MCP flow and tool gating, not artifacts, which get
		// their own fixture in artifacts.spec.ts.
		model: {
			id: "test/model",
			name: "test/model",
			supportsTools: true,
			supportsArtifacts: false,
			parameters: {},
		},
		conv: { _id: new ObjectId() },
		messages: [{ from: "user", content: "hello" }],
		locals: {},
	} as unknown as RunMcpFlowContext;
}

/** Drive the flow to completion, collecting what it yielded and what it returned. */
async function runFlow(overrides: Partial<Parameters<typeof runMcpFlow>[0]> = {}) {
	const updates: MessageUpdate[] = [];
	const generator = runMcpFlow({ ...context(), ...overrides } as Parameters<typeof runMcpFlow>[0]);
	let step = await generator.next();
	while (!step.done) {
		updates.push(step.value);
		step = await generator.next();
	}
	return { updates, result: step.value as McpFlowResult };
}

/** The messages sent on the nth upstream request (0-indexed). */
function requestMessages(n: number): ChatCompletionMessageParam[] {
	return mocks.create.mock.calls[n][0].messages;
}

function streamedText(updates: MessageUpdate[]) {
	return updates
		.filter((u) => u.type === MessageUpdateType.Stream)
		.map((u) => (u.type === MessageUpdateType.Stream ? u.token : ""))
		.join("");
}

function finalAnswer(updates: MessageUpdate[]) {
	const answer = updates.find((u) => u.type === MessageUpdateType.FinalAnswer);
	return answer?.type === MessageUpdateType.FinalAnswer ? answer.text : undefined;
}

beforeEach(async () => {
	mocks.create.mockReset();
	mocks.executeToolCalls.mockReset();
	mocks.getAbortTime.mockReset();
	mocks.mcpTools = [{ type: "function", function: { name: "do_thing" } }];
	mocks.multimodalFlags = [];
	mocks.servers = [{ name: "hf", url: "https://example.test/mcp" }];
	mocks.listedServers = [];
	mocks.sentTools = [];
	// The fixture's one server is loaded from the start of every turn, as before.
	await collections.connectorModes.deleteMany({});
	await collections.connectorModes.insertOne({
		_id: new ObjectId(),
		key: "base:hf",
		mode: "on",
		alwaysLoaded: true,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	mocks.codeToolEnabled = "true";
	mocks.askQuestionEnabled = undefined;
	mocks.unlisted = [];
	mocks.delegation = "false";
	mocks.visible = [];
	mocks.searchGranted = [];
	mocks.documentCaps = null;
	mocks.useUserToken = "false";
	mocks.getAbortTime.mockReturnValue(undefined);
	scriptToolResults();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("runMcpFlow", () => {
	it("answers directly when the model calls no tools", async () => {
		scriptRounds([{ content: "the answer" }]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(streamedText(updates)).toBe("the answer");
		expect(finalAnswer(updates)).toBe("the answer");
		expect(mocks.executeToolCalls).not.toHaveBeenCalled();
	});

	it("runs a tool and feeds its result back for the follow-up answer", async () => {
		scriptRounds([
			{ toolCalls: [{ id: "call_1", name: "do_thing", arguments: '{"a":1}' }] },
			{ content: "done" },
		]);
		scriptToolResults("the tool output");

		const { result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).toHaveBeenCalledTimes(1);
		// The call the model made has to reach the tool intact...
		expect(mocks.executeToolCalls.mock.calls[0][0].calls).toEqual([
			{ id: "call_1", name: "do_thing", arguments: '{"a":1}' },
		]);

		// ...and the follow-up has to carry the assistant's tool_calls *and* the matching
		// results. An assistant message without its tool_calls leaves the tool messages
		// orphaned, which providers reject outright. content is always present —
		// null when no preamble was streamed: a missing key reads as undefined
		// and llmbase-class validators reject it.
		const followUp = requestMessages(1);
		expect(followUp.at(-2)).toEqual({
			role: "assistant",
			content: null,
			tool_calls: [
				{ id: "call_1", type: "function", function: { name: "do_thing", arguments: '{"a":1}' } },
			],
		});
		expect(followUp.at(-1)).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: "the tool output",
		});
	});
});

/** The system prompt of the first upstream request. */
function systemPrompt(): string {
	const first = requestMessages(0)[0];
	return first?.role === "system" && typeof first.content === "string" ? first.content : "";
}

describe("runMcpFlow and connectors on demand (ADR 0104)", () => {
	const hf = { name: "hf", url: "https://example.test/mcp" };
	const osm = { name: "osm", url: "https://osm.test/mcp" };

	// The fixture's tool listing: every server lists one tool named after it, except hf's `do_thing`.
	beforeEach(() => {
		mocks.servers = [hf, osm];
		mocks.listTools = (servers: { name: string }[]) => {
			const tools = servers.map((s) => ({
				type: "function" as const,
				function: { name: s.name === "hf" ? "do_thing" : `${s.name}_find` },
			}));
			const mapping = Object.fromEntries(
				servers.map((s, i) => [
					tools[i].function.name,
					{ fnName: tools[i].function.name, server: s.name, tool: tools[i].function.name },
				])
			);
			return { tools, mapping, unavailable: [] };
		};
		rememberTools(osm.url, [{ name: "osm_find", description: "Find places on the map." }]);
	});
	afterEach(() => {
		mocks.listTools = undefined;
		resetCatalogCache();
	});

	const sentTools = (n: number): string[] => mocks.sentTools[n];

	it("lists a connector that is not loaded as one line, with none of its tools", async () => {
		scriptRounds([{ content: "ok" }]);
		await runFlow();
		expect(sentTools(0)).toContain("do_thing");
		expect(sentTools(0)).not.toContain("osm_find");
		expect(sentTools(0)).toContain("load_tools");
		const prompt = systemPrompt();
		expect(prompt).toContain("- osm: Find places on the map. Tools: osm_find.");
		// Always-loaded connectors skip the list.
		expect(prompt).not.toContain("- hf:");
		// Only the loaded one was ever listed.
		expect(mocks.listedServers.flat()).toEqual(["hf"]);
	});

	it("loads a connector the conversation loaded before, after the tools already there", async () => {
		scriptRounds([{ content: "ok" }]);
		await runFlow({
			conv: { _id: new ObjectId(), loadedConnectors: ["base:osm"] },
		} as never);
		const names = sentTools(0);
		expect(names).toEqual(expect.arrayContaining(["do_thing", "osm_find"]));
		expect(names.indexOf("osm_find")).toBeGreaterThan(names.indexOf("do_thing"));
		// Still a line, so the system prompt does not change when a connector gets loaded.
		expect(systemPrompt()).toContain("- osm:");
	});

	it("load_tools adds the tools for the next round, appended, and remembers them on the conversation", async () => {
		const conv = { _id: new ObjectId(), messages: [] } as never;
		await collections.conversations.insertOne({
			_id: (conv as { _id: ObjectId })._id,
			messages: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		mocks.executeToolCalls.mockImplementation(async function* ({
			calls,
			builtinTools,
		}: {
			calls: Array<{ id: string; name: string; arguments: string }>;
			builtinTools: Array<{
				name: string;
				execute: (a: unknown, c: unknown) => Promise<{ resultText: string }>;
			}>;
		}) {
			const tool = builtinTools.find((t) => t.name === calls[0].name);
			if (!tool) throw new Error("no such builtin");
			const result = await tool.execute(JSON.parse(calls[0].arguments), { uuid: "u" });
			yield {
				type: "complete",
				summary: {
					toolMessages: [{ role: "tool", tool_call_id: calls[0].id, content: result.resultText }],
					toolRuns: [],
				},
			};
		});
		scriptRounds([
			{ toolCalls: [{ id: "c1", name: "load_tools", arguments: '{"connectors":["osm"]}' }] },
			{ content: "done" },
		]);
		await runFlow({ conv } as never);
		expect(sentTools(0)).not.toContain("osm_find");
		const second = sentTools(1);
		expect(second).toContain("osm_find");
		// Appended: everything sent the first time is in the same place.
		expect(second.slice(0, sentTools(0).length)).toEqual(sentTools(0));
		const toolMessage = requestMessages(1).find((m) => m.role === "tool");
		expect(String(toolMessage?.content)).toContain("Loaded osm");
		const row = await collections.conversations.findOne({ _id: (conv as { _id: ObjectId })._id });
		expect(row?.loadedConnectors).toEqual(["base:osm"]);
		await collections.conversations.deleteOne({ _id: (conv as { _id: ObjectId })._id });
	});

	it("loads the connector when the model calls one of its tools by name", async () => {
		const seen: string[][] = [];
		mocks.executeToolCalls.mockImplementation(async function* ({
			mapping,
		}: {
			mapping: Record<string, unknown>;
		}) {
			seen.push(Object.keys(mapping));
			yield {
				type: "complete",
				summary: {
					toolMessages: [{ role: "tool", tool_call_id: "c1", content: "ok" }],
					toolRuns: [],
				},
			};
		});
		scriptRounds([
			{ toolCalls: [{ id: "c1", name: "osm_find", arguments: "{}" }] },
			{ content: "done" },
		]);
		await runFlow();
		expect(seen[0]).toContain("osm_find");
		expect(sentTools(1)).toContain("osm_find");
	});

	it("does not offer a locked-off or off connector, and honours a person's own switch", async () => {
		await collections.connectorModes.insertOne({
			_id: new ObjectId(),
			key: "base:osm",
			mode: "off",
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		scriptRounds([{ content: "ok" }]);
		await runFlow({ conv: { _id: new ObjectId(), loadedConnectors: ["base:osm"] } } as never);
		expect(sentTools(0)).not.toContain("osm_find");
		expect(systemPrompt()).not.toContain("- osm:");
	});
});

describe("runMcpFlow connectors that did not load", () => {
	it("tells the model which selected connector has no credential, and not to fake it", async () => {
		scriptRounds([{ content: "jmcp is not signed in" }]);

		await runFlow({
			locals: {
				mcp: { unavailable: [{ name: "jmcp", reason: "not signed in, or its token is missing" }] },
			},
		} as never);

		const prompt = systemPrompt();
		expect(prompt).toContain("UNAVAILABLE CONNECTORS");
		expect(prompt).toContain("- jmcp: not signed in, or its token is missing");
		expect(prompt).toMatch(/code execution in particular has no network access/);
	});

	it("names a connector whose tool listing failed this turn", async () => {
		mocks.unlisted = [{ name: "jmcp", reason: "the server refused the credential" }];
		scriptRounds([{ content: "ok" }]);

		await runFlow();

		expect(systemPrompt()).toContain("- jmcp: the server refused the credential");
	});

	it("names a connector once when both paths report it", async () => {
		mocks.unlisted = [{ name: "jmcp", reason: "listing failed" }];
		scriptRounds([{ content: "ok" }]);

		await runFlow({
			locals: { mcp: { unavailable: [{ name: "jmcp", reason: "no token" }] } },
		} as never);

		expect(systemPrompt().match(/- jmcp:/g)).toHaveLength(1);
	});

	it("puts the administrator's block first on a tool turn, and the per-turn notice after the user's prompts", async () => {
		scriptRounds([{ content: "ok" }]);
		const block =
			"Instructions from this deployment's administrator:\nRULES\nEnd of the administrator's instructions.";

		await runFlow({
			adminInstructions: block,
			// What index.ts hands over: the block already leads the preprompt.
			preprompt: `${block}\n\nGLOBAL PROMPT`,
			locals: { mcp: { unavailable: [{ name: "jmcp", reason: "no token" }] } },
		} as never);

		const prompt = systemPrompt();
		expect(prompt.startsWith(block)).toBe(true);
		expect(prompt.split("RULES")).toHaveLength(2);
		expect(prompt).toContain("Do NOT call a tool unless");
		expect(prompt.indexOf("Do NOT call a tool unless")).toBeGreaterThan(prompt.indexOf("RULES"));
		expect(prompt.indexOf("GLOBAL PROMPT")).toBeLessThan(prompt.indexOf("UNAVAILABLE CONNECTORS"));
	});

	it("says nothing when every connector loaded", async () => {
		scriptRounds([{ content: "ok" }]);

		await runFlow();

		expect(systemPrompt()).not.toContain("UNAVAILABLE CONNECTORS");
	});
});

describe("runMcpFlow think-tag balance across tool rounds", () => {
	const toolCallDelta = {
		tool_calls: [{ index: 0, id: "call_1", function: { name: "do_thing", arguments: "{}" } }],
	};
	const thinkBalance = (text: string) =>
		(text.match(/<think>/g)?.length ?? 0) - (text.match(/<\/think>/g)?.length ?? 0);

	it("still closes a streamed think block when content arrives after tool-call deltas", async () => {
		// Reasoning streams (client sees "<think>…"), tool-call deltas mute the
		// stream, and only then does the content delta close the block. The closer
		// must still reach the client, or it renders that reasoning as streaming —
		// and re-expands it — for the rest of the turn.
		scriptRounds([
			{
				deltas: [{ reasoning: "planning the call" }, toolCallDelta, { content: "Calling now." }],
				finishReason: "tool_calls",
			},
			{ content: "done" },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		const streamed = streamedText(updates);
		expect(streamed).toContain("<think>planning the call");
		expect(thinkBalance(streamed)).toBe(0);
	});

	it("closes a streamed think block that tool-call deltas leave open", async () => {
		scriptRounds([
			{
				deltas: [{ reasoning: "planning the call" }, toolCallDelta],
				finishReason: "tool_calls",
			},
			{ content: "done" },
		]);

		const { updates } = await runFlow();

		expect(thinkBalance(streamedText(updates))).toBe(0);
	});

	it("streams no stray closer when the opener was never streamed", async () => {
		// Content streams first, then tool-call deltas mute the stream, then
		// reasoning opens a think block the client never saw. A bare "</think>"
		// would render as literal text.
		scriptRounds([
			{
				deltas: [{ content: "Calling now." }, toolCallDelta, { reasoning: "post-call thoughts" }],
				finishReason: "tool_calls",
			},
			{ content: "done" },
		]);

		const { updates } = await runFlow();

		expect(streamedText(updates)).not.toContain("</think>");
	});
});

describe("runMcpFlow truncated tool calls", () => {
	it("retries with an assistant turn when a tool-only round is cut off", async () => {
		scriptRounds([
			{
				toolCalls: [{ id: "call_1", name: "do_thing", arguments: '{"content":"import tor' }],
				finishReason: "length",
			},
			{ content: "smaller answer" },
		]);

		const { result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).not.toHaveBeenCalled();

		// A tool-only round leaves no prose, so without a synthesized assistant turn the
		// nudge would be a second consecutive user message and strict providers 400.
		const retry = requestMessages(1);
		expect(retry.at(-2)?.role).toBe("assistant");
		// Empty content next to no tool_calls is itself rejected by some backends.
		expect(String(retry.at(-2)?.content ?? "")).not.toHaveLength(0);
		expect(retry.at(-1)?.role).toBe("user");
		expect(String(retry.at(-1)?.content)).toContain("output limit");
	});

	it("runs a complete tool call even when the round hit the output limit", async () => {
		scriptRounds([
			{
				toolCalls: [{ id: "call_1", name: "do_thing", arguments: '{"a":1}' }],
				finishReason: "length",
			},
			{ content: "done" },
		]);

		const { result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).toHaveBeenCalledTimes(1);
		expect(mocks.executeToolCalls.mock.calls[0][0].calls).toEqual([
			{ id: "call_1", name: "do_thing", arguments: '{"a":1}' },
		]);
	});

	it("gives up and answers after repeated truncation instead of hanging on", async () => {
		const cutOff: Round = {
			toolCalls: [{ id: "call_1", name: "do_thing", arguments: '{"content":"import tor' }],
			finishReason: "length",
		};
		scriptRounds([cutOff, cutOff, cutOff]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).not.toHaveBeenCalled();
		expect(mocks.create).toHaveBeenCalledTimes(3);
		expect(finalAnswer(updates)).toContain("output limit");
	});
});

describe("runMcpFlow transient upstream failures", () => {
	// Scripts `upstream` for the first round and a clean answer for the second,
	// then drives the backoff sleep to completion.
	const runAbsorbing = async (upstream: Error) => {
		// Fake only the timer pair the backoff sleep uses: the flow crosses real
		// async boundaries (dynamic import, mocked promises) before it ever
		// schedules the sleep, and a blanket fake would starve those of event-loop
		// turns.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		try {
			scriptRounds([{ error: upstream }, { content: "the answer" }]);

			const pending = runFlow();
			let settled = false;
			const flagSettled = () => {
				settled = true;
			};
			void pending.then(flagSettled, flagSettled);
			// The backoff sleep is the only fake-timer client here, so its
			// registration — not a wall-clock budget — is the signal to advance the
			// clock. A fixed number of advance/yield rounds can be exhausted before a
			// slow runner even reaches the sleep, leaving its timer to hang forever.
			// A flow that settles without a timer let the failure escape; fall
			// through and let the assertions name that.
			while (!settled && vi.getTimerCount() === 0) {
				await new Promise((resolve) => setImmediate(resolve));
			}
			if (vi.getTimerCount() > 0) {
				await vi.advanceTimersByTimeAsync(RETRY_BACKOFF_MS[0]);
			}
			return await pending;
		} finally {
			vi.useRealTimers();
		}
	};

	it("absorbs a router 429 with backoff instead of failing a turn mid-flight", async () => {
		const { updates, result } = await runAbsorbing(
			Object.assign(new Error('429 "Rate limit exceeded"'), { status: 429 })
		);

		expect(result).toBe("completed");
		expect(finalAnswer(updates)).toBe("the answer");
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it("absorbs a 503 from a router with no backend ready", async () => {
		// The failure that ended two turns of a six-hour run: the same request
		// succeeds unchanged seconds later, so surfacing it discards the turn.
		const { updates, result } = await runAbsorbing(
			Object.assign(new Error("503 no available server"), { status: 503 })
		);

		expect(result).toBe("completed");
		expect(finalAnswer(updates)).toBe("the answer");
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it("absorbs a connection that never reached the router", async () => {
		// A DNS blip on the machine running chat-ui arrives as APIConnectionError,
		// with no status to match on.
		const { updates, result } = await runAbsorbing(
			new APIConnectionError({ message: "Connection error." })
		);

		expect(result).toBe("completed");
		expect(finalAnswer(updates)).toBe("the answer");
		expect(mocks.create).toHaveBeenCalledTimes(2);
	});

	it("still surfaces a failure that a retry cannot fix", async () => {
		scriptRounds([{ error: Object.assign(new Error("400 bad request"), { status: 400 }) }]);
		const { result } = await runFlow();
		// Fails before any output: the flow falls back rather than erroring the turn.
		expect(result).toBe("not_applicable");
		expect(mocks.create).toHaveBeenCalledTimes(1);
	});
});

describe("runMcpFlow answers cut by the output limit", () => {
	it("retries once when the final answer dies mid-reasoning instead of finalizing the half-thought", async () => {
		scriptRounds([
			{ reasoning: "the method is defined as", finishReason: "length" },
			{ content: "the recovered answer" },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(finalAnswer(updates)).toBe("the recovered answer");
		const retry = requestMessages(1);
		// Reasoning-only rounds leave no prose; the synthesized assistant turn keeps
		// the nudge from being a second consecutive user message.
		expect(retry.at(-2)?.role).toBe("assistant");
		expect(String(retry.at(-2)?.content ?? "")).not.toHaveLength(0);
		expect(String(retry.at(-1)?.content)).toContain("output limit");
	});

	it("finalizes as interrupted when the retry is cut too", async () => {
		scriptRounds([
			{ reasoning: "first half-thought", finishReason: "length" },
			{ reasoning: "second half-thought", finishReason: "length" },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		const answer = updates.find((u) => u.type === MessageUpdateType.FinalAnswer);
		expect(answer?.type === MessageUpdateType.FinalAnswer && answer.interrupted).toBe(true);
	});

	// A stream that dies mid-<think> ends with "stop" (or nothing), not "length" —
	// the failure is the same think-only non-answer and gets the same retry.
	it("retries a think-only answer even without a length signal", async () => {
		scriptRounds([{ reasoning: "half a thought" }, { content: "the recovered answer" }]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(finalAnswer(updates)).toBe("the recovered answer");
		const retry = requestMessages(1);
		expect(retry.at(-2)?.role).toBe("assistant");
		expect(String(retry.at(-1)?.content)).toContain("internal reasoning");
	});

	it("finalizes a repeated think-only answer as interrupted", async () => {
		scriptRounds([{ reasoning: "half a thought" }, { reasoning: "another half-thought" }]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		const answer = updates.find((u) => u.type === MessageUpdateType.FinalAnswer);
		expect(answer?.type === MessageUpdateType.FinalAnswer && answer.interrupted).toBe(true);
	});
});

describe("runMcpFlow termination", () => {
	it("finalizes instead of reporting it never ran when the tool rounds run out", async () => {
		const toolRound: Round = {
			toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }],
		};
		// The 21st request is the no-tools answer; it fails here, so the turn
		// ends on the canned message.
		scriptRounds([...Array.from({ length: 20 }, () => toolRound), { error: new Error("down") }]);

		const { updates, result } = await runFlow();

		// "not_applicable" would make the caller re-run the turn with no tools and
		// discard all twenty rounds of work.
		expect(result).toBe("exhausted");
		expect(mocks.create).toHaveBeenCalledTimes(21);
		expect(finalAnswer(updates)).toBeDefined();
	});

	it("falls back when it fails before showing anything", async () => {
		scriptRounds([{ error: new Error("upstream down") }]);

		const { result } = await runFlow();

		expect(result).toBe("not_applicable");
	});

	it("rethrows a failure that happens after output was streamed", async () => {
		scriptRounds([
			{ toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }] },
			{ error: new Error("upstream died mid-run") },
		]);

		await expect(runFlow()).rejects.toThrow("upstream died mid-run");
	});
});

describe("runMcpFlow in-loop reasoning echo", () => {
	/** The assistant turn carrying this round's tool_calls, as sent upstream. */
	function toolCallMessage(n: number) {
		return requestMessages(n).find(
			(m) => m.role === "assistant" && "tool_calls" in m && m.tool_calls
		) as (ChatCompletionMessageParam & { reasoning_content?: string }) | undefined;
	}

	const withReasoning = () => {
		scriptRounds([
			{
				reasoning: "I need the tool.",
				toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }],
			},
			{ content: "done" },
		]);
	};

	it("echoes the round's reasoning back by default", async () => {
		withReasoning();

		await runFlow();

		expect(toolCallMessage(1)?.reasoning_content).toBe("I need the tool.");
	});

	it("omits reasoning_content for a blocklisted model", async () => {
		// Not cosmetic: this family's provider rejects the field outright rather
		// than ignoring it —
		//   400 messages.2.assistant.reasoning_content: property ... is unsupported
		// — which would end the conversation mid-tool-loop. Emitting a trace and
		// accepting one back are different capabilities, and only the blocklist
		// knows the difference.
		withReasoning();

		await runFlow({
			model: { ...context().model, id: "google/gemma-4-31B-it", preservesReasoning: false },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		const message = toolCallMessage(1);
		expect(message).toBeDefined();
		expect(message && "reasoning_content" in message).toBe(false);
	});

	it("honours a user override that turns reasoning on for a blocklisted model", async () => {
		withReasoning();

		await runFlow({
			reasoningOverride: true,
			model: { ...context().model, preservesReasoning: false },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(toolCallMessage(1)?.reasoning_content).toBe("I need the tool.");
	});

	it("honours a user override that turns reasoning off", async () => {
		withReasoning();

		await runFlow({ reasoningOverride: false } as Partial<Parameters<typeof runMcpFlow>[0]>);

		const message = toolCallMessage(1);
		expect(message && "reasoning_content" in message).toBe(false);
	});
});

describe("runMcpFlow capability overrides", () => {
	it("skips the flow when the user turns tools off for a tools-advertised model", async () => {
		scriptRounds([{ content: "the answer" }]);

		const { result } = await runFlow({ forceTools: false });

		expect(result).toBe("not_applicable");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("runs the flow when the user turns tools on for a model advertising none", async () => {
		scriptRounds([{ content: "the answer" }]);

		const { result } = await runFlow({
			forceTools: true,
			model: { ...context().model, supportsTools: false },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalled();
	});

	it("still skips the flow for a model advertising no tools and no override", async () => {
		scriptRounds([{ content: "the answer" }]);

		const { result } = await runFlow({
			model: { ...context().model, supportsTools: false },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(result).toBe("not_applicable");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("excludes images when the user turns image input off for a multimodal model", async () => {
		scriptRounds([{ content: "the answer" }]);

		await runFlow({
			forceMultimodal: false,
			model: { ...context().model, multimodal: true },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(mocks.multimodalFlags.at(-1)).toBe(false);
	});

	it("sends images when the user turns image input on for a model advertising none", async () => {
		scriptRounds([{ content: "the answer" }]);

		await runFlow({
			forceMultimodal: true,
			model: { ...context().model, multimodal: false },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(mocks.multimodalFlags.at(-1)).toBe(true);
	});

	it("keeps the advertised multimodal value without an override", async () => {
		scriptRounds([{ content: "the answer" }]);

		await runFlow({
			model: { ...context().model, multimodal: true },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(mocks.multimodalFlags.at(-1)).toBe(true);
	});
});

describe("runMcpFlow offering the question tool", () => {
	const toolNames = () =>
		(
			(mocks.create.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> })
				?.tools ?? []
		).map((t) => t.function.name);

	it("offers it alongside the MCP tools, unless the deployment switch is off", async () => {
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		expect(toolNames()).toContain("ask_user_question");
	});

	it("withholds it when the switch is off", async () => {
		mocks.askQuestionEnabled = "false";
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		// execute_code rides on the deployment flag alone — which is why it is
		// here at all with the flag forced on. load_skill and load_skill_file ride on the seeded skills the same way
		// (Phase 1/Stage 3): the frontmatter list is in every turn's system
		// prompt, so the tools that load a body and its bundled files are
		// offered wherever the list is.
		expect(toolNames()).toEqual([
			"update_plan",
			"execute_code",
			"load_skill",
			"load_skill_file",
			"do_thing",
		]);
	});

	it("engages the flow with builtin tools alone when MCP listing yields nothing", async () => {
		mocks.mcpTools = [];
		scriptRounds([{ content: "the answer" }]);
		const { result } = await runFlow();
		expect(result).toBe("completed");
		expect(toolNames()).toEqual([
			"update_plan",
			"ask_user_question",
			"execute_code",
			"load_skill",
			"load_skill_file",
		]);
	});

	it("engages the flow on load_skill alone when nothing else is offered", async () => {
		// Flag off, no servers: execute_code withholds itself and there is no
		// MCP tool — but the seeded skills are still available, so the flow
		// engages with exactly the skill loaders. "Truly nothing to offer" now
		// needs the kill-switch as well (covered in the skills service spec).
		mocks.codeToolEnabled = "false";
		mocks.askQuestionEnabled = "false";
		mocks.servers = [];
		scriptRounds([{ content: "the answer" }]);
		const { result } = await runFlow();
		expect(result).toBe("completed");
		expect(toolNames()).toEqual(["update_plan", "load_skill", "load_skill_file"]);
	});
});

describe("runMcpFlow and the generic tool preprompt", () => {
	const systemPrompt = (n = 0) => String(requestMessages(n)[0]?.content ?? "");

	it("sends the generic tool preprompt", async () => {
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		expect(systemPrompt()).toContain("Do NOT call a tool unless");
	});

	const plan = {
		goal: "Ship the feature",
		steps: [{ step: "write it", status: "pending" }],
		version: 1,
		updatedAt: new Date(),
	};
	const offeredNames = () =>
		(
			(mocks.create.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> })
				?.tools ?? []
		).map((t) => t.function.name);

	it("offers the plan tool in an ordinary tool-capable chat, with a short preprompt", async () => {
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		expect(offeredNames()).toContain("update_plan");
		expect(systemPrompt()).toContain("PLAN: for multi-step work");
	});

	it("shows the model its stored plan on the next turn, on the last user message", async () => {
		scriptRounds([{ content: "the answer" }]);
		await runFlow({ conv: { _id: new ObjectId(), plan } } as Partial<
			Parameters<typeof runMcpFlow>[0]
		>);
		const lastUser = requestMessages(0).findLast((m) => m.role === "user");
		expect(String(lastUser?.content)).toContain("CURRENT PLAN");
		expect(String(lastUser?.content)).toContain("Ship the feature");
	});

	it("injects nothing when the chat has no plan yet", async () => {
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		const lastUser = requestMessages(0).findLast((m) => m.role === "user");
		expect(String(lastUser?.content)).not.toContain("CURRENT PLAN");
	});

	it("neither offers the plan tool nor injects a plan when tool calling is off", async () => {
		scriptRounds([{ content: "the answer" }]);
		const { result } = await runFlow({
			forceTools: false,
			conv: { _id: new ObjectId(), plan },
		} as Partial<Parameters<typeof runMcpFlow>[0]>);
		expect(result).toBe("not_applicable");
		expect(mocks.create).not.toHaveBeenCalled();
	});

	it("leaves the catalog completion budget alone", async () => {
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		expect(mocks.create.mock.calls[0][0].max_tokens).toBeUndefined();
	});

	it("answers through a no-tools call when the round budget runs out", async () => {
		const toolRound: Round = { toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }] };
		scriptRounds([
			...Array.from({ length: 20 }, () => toolRound),
			{ content: "Here is what I found, and what I could not." },
		]);
		const { updates, result } = await runFlow();
		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalledTimes(21);
		expect(finalAnswer(updates)).toBe("Here is what I found, and what I could not.");
		expect(streamedText(updates)).toContain("Here is what I found");
		// The extra call has no tools, says to answer now, and keeps every tool result.
		const extra = mocks.create.mock.calls[20][0];
		expect(extra.tools).toBeUndefined();
		expect(extra.tool_choice).toBeUndefined();
		expect(String(extra.messages.at(-1)?.content)).toContain("Answer the person now");
		expect(extra.messages.filter((m: { role: string }) => m.role === "tool")).toHaveLength(20);
	});

	it("answers through a no-tools call when the final round after tools is only reasoning", async () => {
		scriptRounds([
			{ toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }] },
			{ reasoning: "The answer is 42 but I never say it." },
			{ content: "The answer is 42." },
		]);
		const { updates, result } = await runFlow();
		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalledTimes(3);
		expect(finalAnswer(updates)).toBe("The answer is 42.");
		expect(mocks.create.mock.calls[2][0].tools).toBeUndefined();
	});

	it("falls back to the canned message when the no-tools call is empty too", async () => {
		const toolRound: Round = { toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }] };
		scriptRounds([...Array.from({ length: 20 }, () => toolRound), { content: "" }]);
		const { updates, result } = await runFlow();
		expect(result).toBe("exhausted");
		expect(finalAnswer(updates)).toContain("couldn't reach an answer");
		expect(streamedText(updates)).toContain("couldn't reach an answer");
	});

	it("falls back to the canned message when the no-tools call fails", async () => {
		scriptRounds([
			{ toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }] },
			{ reasoning: "Only thinking." },
			{ error: new Error("bad request") },
		]);
		const { updates, result } = await runFlow();
		expect(result).toBe("completed");
		expect(finalAnswer(updates)).toContain("couldn't reach an answer");
	});

	it("does not make the extra call when no tool ran and the answer is empty", async () => {
		scriptRounds([{ reasoning: "Only thinking." }, { content: "Cut-answer retry answers." }]);
		const { updates } = await runFlow();
		// The ordinary cut-answer retry handles this; tools stay on offer.
		expect(finalAnswer(updates)).toBe("Cut-answer retry answers.");
		expect(mocks.create.mock.calls[1][0].tools).toBeDefined();
	});

	it("gives every round of the turn the same tool blocker", async () => {
		scriptRounds([
			{ toolCalls: [{ id: "call_1", name: "do_thing", arguments: "{}" }] },
			{ toolCalls: [{ id: "call_2", name: "do_thing", arguments: "{}" }] },
			{ content: "Done." },
		]);
		await runFlow();
		const blockers = mocks.executeToolCalls.mock.calls.map((c) => c[0].toolBlocker);
		expect(blockers).toHaveLength(2);
		expect(blockers[0]).toBeDefined();
		expect(blockers[0]).toBe(blockers[1]);
	});
});

describe("leaked tool-call markup", () => {
	// Observed with GLM-class models: the provider template leaks the model's
	// native tool syntax into content, so the "call" is text the user sees and
	// nothing runs.
	it("retries once when the final answer writes a tool call as markup", async () => {
		scriptRounds([
			{
				content: 'Let me ask: <do_thing>\n<option label="$5">five</option>\n</do_thing>',
			},
			{ content: "Here is a clean answer." },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(finalAnswer(updates)).toBe("Here is a clean answer.");
		// The nudge names the leaked tool and demands a real call.
		const nudge = requestMessages(1).at(-1);
		expect(nudge?.role).toBe("user");
		expect(String(nudge?.content)).toContain("<do_thing>");
		expect(String(nudge?.content)).toContain("function-calling mechanism");
	});

	it("finalizes as-is when the retry leaks again", async () => {
		scriptRounds([
			{ content: "First leak: <do_thing></do_thing>" },
			{ content: "Second leak: <do_thing></do_thing>" },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(finalAnswer(updates)).toContain("Second leak");
	});

	it("leaves markup for tools that are not in the schema alone", async () => {
		scriptRounds([{ content: "In HTML you might write <div> or even <some_other_tool>." }]);

		const { updates } = await runFlow();

		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(finalAnswer(updates)).toContain("<some_other_tool>");
	});

	it.each([
		'args</arg_key><arg_value>{"job_id": "6a99c12c", "tail": 60, "operation": "logs"}</arg_value></tool_call>',
		'args</arg_key><arg_value>{"job_id": "6a99c5ca", "tail": 40}</arg_value><arg_key>operation</arg_key><arg_value>logs</arg_value></tool_call>',
		'<think>The logs call failed. Retry.</think>{"args": {"job_id": "x", "tail": 80}, "operation": "logs"}</arg_value></tool_call>',
		'<arg_value>{"job_id": "x", "operation": "logs", "tail": 80}</arg_value></tool_call>',
	])("catches the leak tail %#, exactly as the provider streamed it", async (leak) => {
		scriptRounds([{ content: leak }, { content: "Here is a clean answer." }]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(finalAnswer(updates)).toBe("Here is a clean answer.");
	});

	it("retries when a half-parsed leak carries no tool name", async () => {
		// What together's GLM-5.3-Flash actually leaked: the provider consumed
		// `<tool_call>hf_jobs<arg_key>` and streamed the rest as content, so the
		// name a tag-based check needs is not in the text at all.
		scriptRounds([
			{
				content:
					'args</arg_key><arg_value>{"job_id": "6a99c12c", "tail": 60, "operation": "logs"}</arg_value></tool_call>',
			},
			{ content: "Here is a clean answer." },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(finalAnswer(updates)).toBe("Here is a clean answer.");
		const nudge = requestMessages(1).at(-1);
		expect(String(nudge?.content)).toContain("</tool_call>");
		expect(String(nudge?.content)).toContain("function-calling mechanism");
	});

	it("leaves an answer that documents the syntax alone", async () => {
		// A single closing tag turns up in an answer about tool calling, or one
		// quoting sample XML. Discarding it would replace a correct answer with an
		// instruction to make a call nobody asked for.
		scriptRounds([
			{
				content:
					"Providers close the block with </tool_call>, and Hermes-style templates use </function> instead.",
			},
		]);

		const { updates } = await runFlow();

		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(finalAnswer(updates)).toContain("</tool_call>");
	});

	it("leaves prose that only mentions the syntax alone", async () => {
		// An answer about the markup opens tags without closing them; only a
		// closing marker means a call the provider half-parsed.
		scriptRounds([
			{ content: "The template writes <tool_call> and then <arg_key> for each argument." },
		]);

		const { updates } = await runFlow();

		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(finalAnswer(updates)).toContain("<arg_key>");
	});

	it("requires a whole tag, not a prefix", async () => {
		// <do_thing_output> is ordinary content, not a leaked call to do_thing.
		scriptRounds([{ content: "The result arrives in a <do_thing_output> element." }]);

		const { updates } = await runFlow();

		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(finalAnswer(updates)).toContain("<do_thing_output>");
	});
});

describe("leaked execute_code markup recovery", () => {
	// Recorded live (2026-09-15, glm-5.3-flash through the gateway): the same
	// prompt made a real execute_code call in one conversation and, in the next,
	// wrote the call as reply markup twice across two turns — the leaked-markup
	// correction above fired (the persisted stream/finalAnswer lengths show the
	// replaced round) and the model still could not comply. Recovery parses the
	// block out and dispatches it as an ordinary tool call, so the park/resume
	// machinery, the card and the per-turn cap are the standard path's.
	const LEAK =
		'Let me compute that.\n\n<execute_code lang="python">\nprint(1 + 1)\n</execute_code>';

	it("dispatches a leaked block as a real execute_code call", async () => {
		scriptRounds([{ content: LEAK }, { content: "done" }]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).toHaveBeenCalledTimes(1);
		const [dispatch] = mocks.executeToolCalls.mock.calls[0][0].calls;
		expect(dispatch.name).toBe("execute_code");
		expect(dispatch.id).toBeTruthy();
		expect(JSON.parse(dispatch.arguments)).toEqual({ code: "print(1 + 1)" });

		// The follow-up round must see a proper tool call and its result — the
		// same shape a compliant model produces — not the raw markup.
		const followUp = requestMessages(1);
		expect(followUp.at(-2)).toEqual({
			role: "assistant",
			content: expect.stringContaining("Let me compute that."),
			tool_calls: [
				{
					id: dispatch.id,
					type: "function",
					function: { name: "execute_code", arguments: JSON.stringify({ code: "print(1 + 1)" }) },
				},
			],
		});
		expect(followUp.at(-1)).toEqual({
			role: "tool",
			tool_call_id: dispatch.id,
			content: "tool ok",
		});
		expect(finalAnswer(updates)).toBe("done");
	});

	it("parks the turn when the recovered call waits on the browser", async () => {
		mocks.executeToolCalls.mockImplementation(async function* ({
			calls,
		}: {
			calls: Array<{ id: string; name: string }>;
		}) {
			for (const call of calls) {
				yield {
					type: "update" as const,
					update: {
						type: MessageUpdateType.Tool,
						subtype: MessageToolUpdateType.Call,
						uuid: call.id,
						call: { name: call.name, parameters: { code: "print(1 + 1)" } },
					},
				};
			}
			yield {
				type: "complete" as const,
				summary: { toolMessages: [], toolRuns: [], awaitingInput: true },
			};
		});
		scriptRounds([{ content: LEAK }]);

		const { updates, result } = await runFlow();

		// The recovered call parks exactly like a real one: the run ends waiting
		// on the browser, and no FinalAnswer is emitted — the turn is not over.
		expect(result).toBe("awaiting_input");
		expect(updates.some((u) => u.type === MessageUpdateType.FinalAnswer)).toBe(false);
		expect(
			updates.some(
				(u) => u.type === MessageUpdateType.Tool && u.subtype === MessageToolUpdateType.Call
			)
		).toBe(true);
	});

	it("leaves fenced markup alone and lets the leak correction handle it", async () => {
		scriptRounds([
			{
				content:
					'Like this:\n\n```python\n<execute_code lang="python">\nprint(1)\n</execute_code>\n```',
			},
			{ content: "Here is a clean answer." },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).not.toHaveBeenCalled();
		// The correction still fires — the markup names an advertised tool — but
		// the illustration itself never runs.
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(finalAnswer(updates)).toBe("Here is a clean answer.");
	});

	it("does nothing when the reply carries two blocks", async () => {
		scriptRounds([
			{ content: `${LEAK}\n\nAnd also:\n\n<execute_code>\nprint(2)\n</execute_code>` },
			{ content: "Here is a clean answer." },
		]);

		const { result } = await runFlow();

		expect(mocks.executeToolCalls).not.toHaveBeenCalled();
		expect(mocks.create).toHaveBeenCalledTimes(2);
		expect(result).toBe("completed");
	});

	it("recovers at most one call per run", async () => {
		scriptRounds([
			{ content: LEAK },
			// The next leak is past the recovery budget: the correction is what
			// answers it, and the second markup never runs.
			{ content: LEAK },
			{ content: "Here is a clean answer." },
		]);

		const { result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).toHaveBeenCalledTimes(1);
		expect(mocks.create).toHaveBeenCalledTimes(3);
	});

	it("keeps today's behavior when the deployment flag is off", async () => {
		mocks.codeToolEnabled = "false";
		scriptRounds([{ content: LEAK }]);

		const { updates, result } = await runFlow();

		// No advertised execute_code: no recovery, and no correction either — the
		// markup is not a leaked call to any tool this run offered. The turn
		// finalizes exactly as it did before recovery existed.
		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).not.toHaveBeenCalled();
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(finalAnswer(updates)).toContain("<execute_code");
	});

	it("ignores a block the model only wrote inside its reasoning", async () => {
		// The visible text carries no markup; only the reasoning does. Matching
		// the raw reply would run code the model was merely thinking out loud
		// about.
		scriptRounds([
			{
				deltas: [
					{ reasoning: "I will call it like this: <execute_code>print(1)</execute_code>." },
					{ content: "Let me compute that." },
				],
			},
			{ content: "Here is a clean answer." },
		]);

		const { updates, result } = await runFlow();

		expect(result).toBe("completed");
		expect(mocks.executeToolCalls).not.toHaveBeenCalled();
		// Neither the recovery nor the leak correction sees reasoning text: the
		// round simply finalizes its visible answer. (The mocked final answer
		// carries the reasoning inline, as every think-bearing round here does.)
		expect(mocks.create).toHaveBeenCalledTimes(1);
		expect(finalAnswer(updates)).toContain("Let me compute that.");
	});
});

describe("runMcpFlow and sub-agents", () => {
	const offered = () =>
		(
			(mocks.create.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> })
				?.tools ?? []
		).map((t) => t.function.name);
	const definition = (name: string) =>
		(
			mocks.create.mock.calls[0]?.[0] as {
				tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }>;
			}
		).tools?.find((t) => t.function.name === name)?.function;

	it("offers delegate by default to a tool-capable model", async () => {
		mocks.delegation = undefined;
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		expect(offered()).toContain("delegate");
		expect(offered()).not.toContain("research");
		expect(String(requestMessages(0)[0]?.content)).toContain("DELEGATION: use delegate");
	});

	it("drops delegate and research when the administrator turns sub-agents off", async () => {
		mocks.delegation = "false";
		mocks.searchGranted = ["exa"];
		scriptRounds([{ content: "the answer" }]);
		await runFlow({ conv: { _id: new ObjectId(), webSearch: true } } as Partial<
			Parameters<typeof runMcpFlow>[0]
		>);
		expect(offered()).toContain("web_search");
		expect(offered()).not.toContain("delegate");
		expect(offered()).not.toContain("research");
	});

	it("offers neither when the model has tool calling off", async () => {
		mocks.delegation = undefined;
		scriptRounds([{ content: "the answer" }]);
		const { result } = await runFlow({ forceTools: false });
		expect(result).toBe("not_applicable");
	});

	it("adds research wherever web search is available", async () => {
		mocks.delegation = undefined;
		mocks.searchGranted = ["exa"];
		scriptRounds([{ content: "the answer" }]);
		await runFlow({ conv: { _id: new ObjectId(), webSearch: true } } as Partial<
			Parameters<typeof runMcpFlow>[0]
		>);
		expect(offered()).toEqual(expect.arrayContaining(["web_search", "delegate", "research"]));
	});

	it("lets the model pick only models this person can use that can call tools, never custom ones", async () => {
		mocks.delegation = undefined;
		mocks.visible = [
			{ id: "a/tools", displayName: "A", supportsTools: true },
			{ id: "b/notools", displayName: "B", supportsTools: false },
			{ id: "custom:0123456789abcdef01234567", displayName: "Mine", supportsTools: true },
		];
		scriptRounds([{ content: "the answer" }]);
		await runFlow();
		const hint = JSON.stringify(definition("delegate")?.parameters);
		expect(hint).toContain("a/tools");
		expect(hint).not.toContain("b/notools");
		expect(hint).not.toContain("custom:");
	});

	/**
	 * A completion script for a turn that delegates: the main model's rounds
	 * stream, a sub-agent's (stream: false) answer in one piece. The tool
	 * executor runs builtins for real; for the sub-agent's own calls it applies
	 * the guard the loop would, and reports what it decided.
	 */
	function scriptDelegation(delegateArgs: object, nested: Array<Record<string, unknown>>) {
		const main = [
			{ toolCalls: [{ id: "call_d", name: "delegate", arguments: JSON.stringify(delegateArgs) }] },
			{ content: "Synthesised answer." },
		];
		let mainIndex = 0;
		let nestedIndex = 0;
		mocks.create.mockImplementation(async (request: { stream?: boolean }) => {
			if (request.stream === false) {
				const reply = nested[Math.min(nestedIndex++, nested.length - 1)];
				return { choices: [{ finish_reason: "stop", message: reply }], usage: { total_tokens: 5 } };
			}
			return streamFor(main[mainIndex++]);
		});
		mocks.executeToolCalls.mockImplementation(async function* (params: {
			calls: Array<{ id: string; name: string; arguments: string }>;
			builtinTools?: Array<{
				name: string;
				execute: (args: object, ctx: object) => Promise<{ resultText?: string; error?: string }>;
			}>;
			guard?: { before: (call: object) => Promise<{ allow: boolean; message?: string }> };
			elicitation?: object;
			abortSignal?: AbortSignal;
		}) {
			const toolMessages = [];
			for (const call of params.calls) {
				const args = JSON.parse(call.arguments || "{}");
				const found = params.builtinTools?.find((t) => t.name === call.name);
				let content: string;
				if (found) {
					const out = await found.execute(args, {
						uuid: call.id,
						toolCallId: call.id,
						abortSignal: params.abortSignal,
					});
					content = out.error ? `Error: ${out.error}` : (out.resultText ?? "");
				} else {
					const verdict = await params.guard?.before({
						serverUrl: "https://example.test/mcp",
						tool: call.name,
						fnName: call.name,
						args,
						callUuid: call.id,
					});
					content = verdict && !verdict.allow ? `Error: ${verdict.message}` : "mcp ran";
				}
				toolMessages.push({ role: "tool" as const, tool_call_id: call.id, content });
			}
			yield { type: "complete", summary: { toolMessages, toolRuns: [] } };
		});
	}

	const nestedCalls = () =>
		mocks.create.mock.calls.filter(
			([request]) => (request as { stream?: boolean }).stream === false
		);

	it("bills the sub-agent's requests to the person: their token, on their conversation, on the conversation's model", async () => {
		mocks.delegation = undefined;
		mocks.useUserToken = "true";
		scriptDelegation({ task: "Compare the licences of A and B and report back." }, [
			{ content: "A is MIT." },
		]);
		const conv = { _id: new ObjectId() };
		const { result } = await runFlow({
			conv,
			locals: { token: "person-token" },
		} as unknown as Partial<Parameters<typeof runMcpFlow>[0]>);

		expect(result).toBe("completed");
		expect(nestedCalls()).toHaveLength(1);
		const [request, options] = nestedCalls()[0] as [
			{ model: string },
			{ headers: Record<string, string> },
		];
		expect(request.model).toBe("test/model");
		expect(options.headers).toMatchObject({
			Authorization: "Bearer person-token",
			"ChatUI-Conversation-ID": conv._id.toString(),
		});
		// The main model gets the sub-agent's answer back as the tool result.
		const mainRequests = mocks.create.mock.calls
			.map(([request]) => request as { stream?: boolean; messages: ChatCompletionMessageParam[] })
			.filter((request) => request.stream !== false);
		const toolMessage = mainRequests[1].messages.findLast((m) => m.role === "tool");
		expect(toolMessage?.content).toBe("A is MIT.");
	});

	it("keeps a sub-agent from running an MCP tool the person has not approved", async () => {
		mocks.delegation = undefined;
		scriptDelegation({ task: "Use do_thing and report what happened." }, [
			{
				content: null,
				tool_calls: [
					{ id: "n1", type: "function", function: { name: "do_thing", arguments: "{}" } },
				],
			},
		]);
		await runFlow();
		const refusal = nestedCalls()
			.map(([request]) => request as { messages: Array<{ role: string; content?: string }> })
			.flatMap((request) => request.messages)
			.find((m) => m.role === "tool");
		// the first nested reply was the call; the loop ran it through the guard
		expect(nestedCalls().length).toBeGreaterThan(1);
		expect(refusal?.content).toContain("needs the person's approval");
	});

	it("lets a sub-agent use an MCP tool this conversation already approved", async () => {
		mocks.delegation = undefined;
		scriptDelegation({ task: "Use do_thing and report what happened." }, [
			{
				content: null,
				tool_calls: [
					{ id: "n1", type: "function", function: { name: "do_thing", arguments: "{}" } },
				],
			},
			{ content: "It worked." },
		]);
		await runFlow({
			conv: { _id: new ObjectId(), approvedTools: ["hf:do_thing"] },
		} as unknown as Partial<Parameters<typeof runMcpFlow>[0]>);
		const toolMessages = nestedCalls()
			.map(([request]) => request as { messages: Array<{ role: string; content?: string }> })
			.flatMap((request) => request.messages)
			.filter((m) => m.role === "tool");
		expect(toolMessages.some((m) => m.content === "mcp ran")).toBe(true);
	});

	it("Stop reaches a sub-agent that is mid-request: the turn's abort record cancels it within a poll", async () => {
		mocks.delegation = undefined;
		let nestedSignal: AbortSignal | undefined;
		mocks.create.mockImplementation(
			async (request: { stream?: boolean }, options: { signal?: AbortSignal }) => {
				if (request.stream === false) {
					nestedSignal = options.signal;
					// Stop is pressed while the sub-agent waits on the model.
					mocks.getAbortTime.mockReturnValue((Date.now() + 60_000) as unknown as number);
					return new Promise((_resolve, reject) =>
						options.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
							once: true,
						})
					);
				}
				return streamFor({
					toolCalls: [
						{
							id: "call_d",
							name: "delegate",
							arguments: JSON.stringify({ task: "Compare A and B and report back." }),
						},
					],
				});
			}
		);
		mocks.executeToolCalls.mockImplementation(async function* (params: {
			calls: Array<{ id: string; name: string; arguments: string }>;
			builtinTools?: Array<{
				name: string;
				execute: (args: object, ctx: object) => Promise<{ resultText?: string; error?: string }>;
			}>;
			abortSignal?: AbortSignal;
		}) {
			const call = params.calls[0];
			const found = params.builtinTools?.find((t) => t.name === call.name);
			const out = await found?.execute(JSON.parse(call.arguments), {
				uuid: call.id,
				toolCallId: call.id,
				abortSignal: params.abortSignal,
			});
			yield {
				type: "complete",
				summary: {
					toolMessages: [
						{ role: "tool" as const, tool_call_id: call.id, content: out?.error ?? "x" },
					],
					toolRuns: [],
				},
			};
		});
		const controller = new AbortController();
		const { result } = await runFlow({
			abortController: controller,
			abortSignal: controller.signal,
			promptedAt: new Date(),
		} as Partial<Parameters<typeof runMcpFlow>[0]>);
		expect(result).toBe("aborted");
		expect(nestedSignal?.aborted).toBe(true);
	});
});

describe("runMcpFlow and look_doc", () => {
	const RENDER_CAPS = {
		formats: {},
		render: { formats: ["pdf"], image_types: ["png", "jpeg"] },
		limits: { max_render_pages: 6 },
	};
	const offered = () =>
		(
			(mocks.create.mock.calls[0]?.[0] as { tools?: Array<{ function: { name: string } }> })
				?.tools ?? []
		).map((t) => t.function.name);

	it("is offered to a model that sees images, and not to a text-only one", async () => {
		mocks.documentCaps = RENDER_CAPS;
		scriptRounds([{ content: "a" }]);
		await runFlow({ model: { ...context().model, multimodal: true } } as never);
		expect(offered()).toContain("look_doc");

		mocks.create.mockReset();
		scriptRounds([{ content: "b" }]);
		await runFlow({ model: { ...context().model, multimodal: false } } as never);
		expect(offered()).not.toContain("look_doc");
	});

	it("follows the person's image switch, like the images it sends", async () => {
		mocks.documentCaps = RENDER_CAPS;
		scriptRounds([{ content: "a" }]);
		await runFlow({
			forceMultimodal: false,
			model: { ...context().model, multimodal: true },
		} as never);
		expect(offered()).not.toContain("look_doc");

		mocks.create.mockReset();
		scriptRounds([{ content: "b" }]);
		await runFlow({
			forceMultimodal: true,
			model: { ...context().model, multimodal: false },
		} as never);
		expect(offered()).toContain("look_doc");
	});

	it("is absent when the document service cannot draw pages", async () => {
		mocks.documentCaps = { formats: {} };
		scriptRounds([{ content: "a" }]);
		await runFlow({ model: { ...context().model, multimodal: true } } as never);
		expect(offered()).not.toContain("look_doc");
	});

	it("gives the model the pages it asked for as image content in its next request", async () => {
		mocks.documentCaps = RENDER_CAPS;
		const real = await vi.importActual<typeof import("./toolInvocation")>("./toolInvocation");
		// The real executeToolCalls, with a look_doc that answers with two pictures.
		mocks.executeToolCalls.mockImplementation(
			(params: Parameters<typeof real.executeToolCalls>[0]) =>
				real.executeToolCalls({
					...params,
					builtinTools: [
						{
							name: "look_doc",
							definition: { type: "function", function: { name: "look_doc" } },
							execute: async () => ({
								resultText: "deck.pptx has 2 slides. Showing slides 1, 2.",
								images: [
									{ mime: "image/png", base64: "AAAA", label: "deck.pptx, slide 1 of 2" },
									{ mime: "image/jpeg", base64: "BBBB", label: "deck.pptx, slide 2 of 2" },
								],
							}),
						},
					],
				})
		);
		scriptRounds([
			{ toolCalls: [{ id: "call_1", name: "look_doc", arguments: '{"file":"deck.pptx"}' }] },
			{ content: "the slides look fine" },
		]);

		const { result } = await runFlow({
			model: { ...context().model, multimodal: true },
		} as never);

		expect(result).toBe("completed");
		const followUp = requestMessages(1);
		expect(followUp.at(-2)).toEqual({
			role: "tool",
			tool_call_id: "call_1",
			content: "deck.pptx has 2 slides. Showing slides 1, 2.",
		});
		expect(followUp.at(-1)).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "[look_doc result: deck.pptx, slide 1 of 2]" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAAA", detail: "auto" } },
				{ type: "text", text: "[look_doc result: deck.pptx, slide 2 of 2]" },
				{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB", detail: "auto" } },
			],
		});
	});
});
