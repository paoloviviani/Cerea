import { describe, expect, it } from "vitest";
import type OpenAI from "openai";
import type { Stream } from "openai/streaming";
import {
	openAIChatToTextGenerationSingle,
	openAIChatToTextGenerationStream,
} from "./openAIChatToTextGenerationStream";

type Delta = {
	content?: string;
	reasoning?: string;
	reasoning_content?: string;
	reasoning_text?: string;
};

/** Minimal stand-in for the SDK's Stream — the adapter only iterates it. */
function streamOf(deltas: Delta[]): Stream<OpenAI.Chat.Completions.ChatCompletionChunk> {
	return (async function* () {
		for (const delta of deltas) {
			yield { choices: [{ index: 0, delta, finish_reason: null }] };
		}
		yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
	})() as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>;
}

/** Everything the adapter emitted, concatenated — what lands in message.content. */
async function textFrom(deltas: Delta[]): Promise<string> {
	let out = "";
	for await (const output of openAIChatToTextGenerationStream(streamOf(deltas))) {
		if (!output.token.special) out += output.token.text;
	}
	return out;
}

describe("openAIChatToTextGenerationStream reasoning", () => {
	it("wraps reasoning deltas in a single think block", async () => {
		expect(
			await textFrom([
				{ reasoning: "step one " },
				{ reasoning: "step two" },
				{ content: "Answer." },
			])
		).toBe("<think>step one step two</think>Answer.");
	});

	it("does not open a think block for whitespace-only reasoning", async () => {
		// A provider that emits a blank reasoning chunk before any real thinking
		// would otherwise leave an empty <think> in the persisted content, which
		// the UI renders as a stray thinking widget.
		const text = await textFrom([{ reasoning: "  \n" }, { content: "Answer." }]);
		expect(text).not.toContain("<think>");
		expect(text).toBe("Answer.");
	});

	it("keeps leading whitespace byte-exact once real reasoning arrives", async () => {
		// Buffered rather than discarded: vendors documenting preserved thinking
		// can require the reasoning echoed back unmodified, so the bytes have to
		// survive even though they cannot open the block on their own.
		expect(
			await textFrom([{ reasoning: "\n\n" }, { reasoning: "thought" }, { content: "A." }])
		).toBe("<think>\n\nthought</think>A.");
	});

	it("keeps whitespace inside an already-open block", async () => {
		expect(
			await textFrom([{ reasoning: "one" }, { reasoning: "\n\n" }, { reasoning: "two" }])
		).toContain("<think>one\n\ntwo");
	});

	it("accepts reasoning_content and reasoning_text as reasoning", async () => {
		expect(await textFrom([{ reasoning_content: "rc" }, { content: "A." }])).toBe(
			"<think>rc</think>A."
		);
		expect(await textFrom([{ reasoning_text: "rt" }, { content: "A." }])).toBe(
			"<think>rt</think>A."
		);
	});
});

describe("openAIChatToTextGenerationSingle reasoning", () => {
	async function contentFrom(message: Record<string, unknown>): Promise<string | null | undefined> {
		const completion = { choices: [{ index: 0, message, finish_reason: "stop" }] };
		for await (const output of openAIChatToTextGenerationSingle(
			completion as unknown as OpenAI.Chat.Completions.ChatCompletion
		)) {
			if (output.generated_text != null) return output.generated_text;
		}
	}

	it("wraps reasoning in a think block", async () => {
		expect(await contentFrom({ content: "Answer.", reasoning: "thought" })).toBe(
			"<think>thought</think>Answer."
		);
	});

	it("does not emit an empty think block for whitespace-only reasoning", async () => {
		// Same rule as the streaming path above, so both produce the same stored
		// shape for the same upstream response.
		expect(await contentFrom({ content: "Answer.", reasoning: "  \n " })).toBe("Answer.");
	});
});

describe("openAIChatToTextGenerationStream gateway report", () => {
	const REPORT = {
		choices: [],
		usage: { prompt_tokens: 11, completion_tokens: 4 },
		pystino_cost: "0.001 USD",
		pystino_redaction: {
			applied: true,
			blocked: false,
			entities: [{ type: "PERSON", count: 1, sources: ["user"] }],
		},
	};

	it("hands the closing usage chunk's tokens, cost and redaction on, and no text", async () => {
		const stream = (async function* () {
			yield { choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] };
			yield { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
			yield REPORT;
		})() as unknown as Stream<OpenAI.Chat.Completions.ChatCompletionChunk>;

		let text = "";
		let report: unknown;
		for await (const output of openAIChatToTextGenerationStream(stream)) {
			if (!output.token.special) text += output.token.text;
			if ("callReport" in output) report = output.callReport;
		}

		expect(text).toBe("Hi");
		expect(report).toMatchObject({
			inputTokens: 11,
			outputTokens: 4,
			cost: "0.001 USD",
			redaction: { applied: true, entities: [{ type: "PERSON", count: 1 }] },
		});
	});

	it("emits nothing extra when the gateway reports nothing", async () => {
		const outputs = [];
		for await (const output of openAIChatToTextGenerationStream(streamOf([{ content: "x" }]))) {
			outputs.push(output);
		}
		expect(outputs.some((o) => "callReport" in o)).toBe(false);
	});

	it("reads the same fields from a non-streaming body", async () => {
		const outputs = [];
		for await (const output of openAIChatToTextGenerationSingle({
			choices: [
				{ index: 0, message: { role: "assistant", content: "Hello" }, finish_reason: "stop" },
			],
			usage: { prompt_tokens: 2, completion_tokens: 1 },
			pystino_redaction: { applied: false, blocked: false, entities: [] },
		} as unknown as OpenAI.Chat.Completions.ChatCompletion)) {
			outputs.push(output);
		}
		const withReport = outputs.find((o) => "callReport" in o);
		expect(withReport?.callReport).toMatchObject({
			inputTokens: 2,
			outputTokens: 1,
			redaction: { applied: false },
		});
	});
});
