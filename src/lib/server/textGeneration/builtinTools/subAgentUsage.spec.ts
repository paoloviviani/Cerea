import { describe, expect, it, vi } from "vitest";
import type { OpenAI } from "openai";
import { TurnStatsCollector, type CallReport } from "$lib/server/turnStats";
import { runNestedAgent, type NestedAgentDeps, type NestedAgentSpec } from "./nestedAgent";
import { openAiComplete } from "./browseTool";
import type { BuiltinTool } from "./types";

/**
 * Sub-agent model calls report their usage into the turn's collector, in a
 * bucket of their own: the totals include them, the breakdown shows them, and
 * speed and first-token time stay the main model's.
 */

const searchTool: BuiltinTool = {
	name: "web_search",
	definition: {
		type: "function",
		function: { name: "web_search", description: "search", parameters: { type: "object" } },
	},
	execute: async () => ({ resultText: "found" }),
};

type Usage = { prompt_tokens: number; completion_tokens: number; total_tokens: number };

/** An upstream that calls web_search once, then answers; each response carries usage and a cost. */
function upstream(usage: Usage, cost?: string) {
	let n = 0;
	const create = vi.fn(async () => {
		n += 1;
		const calling = n % 2 === 1;
		return {
			choices: [
				{
					finish_reason: calling ? "tool_calls" : "stop",
					message: {
						content: calling ? null : "done",
						tool_calls: calling
							? [
									{
										id: `c${n}`,
										type: "function",
										function: { name: "web_search", arguments: "{}" },
									},
								]
							: [],
					},
				},
			],
			usage,
			...(cost ? { pystino_cost: cost } : {}),
		};
	});
	return { chat: { completions: { create } } } as unknown as OpenAI;
}

function depsFor(openai: OpenAI, stats: TurnStatsCollector): NestedAgentDeps {
	return {
		openai,
		completionBase: { model: "test/model", stream: true },
		requestHeaders: {},
		reportUsage: (report) => stats.reportSubAgent(report),
		servers: [],
		mapping: {},
		mcpTools: [],
		hostBuiltinTools: [searchTool],
	};
}

const spec = (): NestedAgentSpec => ({
	label: "delegate",
	displayName: "Sub-agent",
	systemPrompt: "system",
	task: "the brief",
	allowedTools: new Set(["web_search"]),
	maxIterations: 5,
	truncateOutput: (text) => text,
	stop: { contextWarn: "w", contextMax: "c", iterationLimit: "i", repetition: "r" },
	failure: {
		noTools: "n",
		contextMax: "c",
		iterationLimit: "i",
		noSummary: "s",
		rateLimited: "r",
	},
	progress: { start: "start", done: "done" },
});

const ctx = { uuid: "u1" } as never;

function mainCall(stats: TurnStatsCollector) {
	const call = stats.begin();
	call.token();
	call.report = { inputTokens: 1000, outputTokens: 200, reasoningTokens: 30, cost: "0.0100 USD" };
}

describe("a delegation turn", () => {
	it("adds the sub-agent's calls to the totals and keeps them as a breakdown", async () => {
		const stats = new TurnStatsCollector({ model: "Main" });
		mainCall(stats);
		const usage = { prompt_tokens: 400, completion_tokens: 30, total_tokens: 430 };
		const result = await runNestedAgent(spec(), ctx, depsFor(upstream(usage, "0.0010 USD"), stats));
		expect(result).toEqual({ resultText: "done" });

		const snap = stats.snapshot();
		// Two sub-agent completions: the tool round and the answer.
		expect(snap).toMatchObject({
			subAgentCalls: 2,
			subAgentInputTokens: 800,
			subAgentOutputTokens: 60,
			inputTokens: 1800,
			outputTokens: 260,
			cost: "0.0120 USD",
		});
		// Reasoning was reported by the main call only: no sub-agent figure, no null.
		expect(snap.reasoningTokens).toBe(30);
		expect("subAgentReasoningTokens" in snap).toBe(false);
	});

	it("counts parallel sub-agents, none lost", async () => {
		const stats = new TurnStatsCollector();
		const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
		await Promise.all(
			[1, 2, 3].map(() => runNestedAgent(spec(), ctx, depsFor(upstream(usage), stats)))
		);
		expect(stats.snapshot()).toMatchObject({
			subAgentCalls: 6,
			subAgentInputTokens: 600,
			subAgentOutputTokens: 60,
			inputTokens: 600,
		});
	});

	it("leaves speed and first-token time to the main model", () => {
		let now = 0;
		const stats = new TurnStatsCollector({ now: () => now });
		const call = stats.begin();
		now = 500;
		call.token();
		now = 1500;
		call.token();
		call.report = { outputTokens: 20 };
		const before = stats.snapshot();
		stats.reportSubAgent({ inputTokens: 5000, outputTokens: 9000 });
		const after = stats.snapshot();
		expect(after.firstTokenMs).toBe(before.firstTokenMs);
		expect(after.tokensPerSecond).toBe(before.tokensPerSecond);
		expect(after.outputTokens).toBe(9020);
	});

	it("shows no sub-agent fields when there were no sub-agent calls", () => {
		const stats = new TurnStatsCollector();
		mainCall(stats);
		const snap = stats.snapshot();
		expect(Object.keys(snap).filter((k) => k.startsWith("subAgent"))).toEqual([]);
		expect(Object.values(snap).every((v) => v !== undefined)).toBe(true);
	});
});

describe("a browse turn", () => {
	it("reports each of the browse loop's model calls", async () => {
		const stats = new TurnStatsCollector();
		mainCall(stats);
		const create = vi.fn(async () => ({
			choices: [{ finish_reason: "stop", message: { content: "ok", tool_calls: [] } }],
			usage: { prompt_tokens: 41_200, completion_tokens: 3_100, total_tokens: 44_300 },
			pystino_cost: "0.0200 USD",
		}));
		const complete = openAiComplete(
			{
				openai: { chat: { completions: { create } } },
				completionBase: { model: "chat-model" },
				requestHeaders: {},
				reportUsage: (report: CallReport) => stats.reportSubAgent(report),
			} as unknown as NestedAgentDeps,
			"chat-model",
			true
		);
		const turn = await complete({ messages: [{ role: "user", content: "go" }] });
		expect(turn.totalTokens).toBe(44_300);
		expect(stats.snapshot()).toMatchObject({
			subAgentCalls: 1,
			subAgentInputTokens: 41_200,
			subAgentOutputTokens: 3_100,
			inputTokens: 42_200,
			outputTokens: 3_300,
			cost: "0.0300 USD",
		});
	});

	it("works with no reporter bound (a test seam, or a turn without one)", async () => {
		const create = vi.fn(async () => ({
			choices: [{ finish_reason: "stop", message: { content: "ok", tool_calls: [] } }],
		}));
		const complete = openAiComplete(
			{
				openai: { chat: { completions: { create } } },
				completionBase: { model: "m" },
				requestHeaders: {},
			} as unknown as NestedAgentDeps,
			"m",
			true
		);
		await expect(complete({ messages: [] })).resolves.toMatchObject({ content: "ok" });
	});
});
