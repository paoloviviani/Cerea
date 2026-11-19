import { describe, expect, it } from "vitest";
import type { OpenAI } from "openai";
import { CONTINUE_PROMPT, endOnUserTurn } from "./endOnUserTurn";

type Msg = OpenAI.Chat.Completions.ChatCompletionMessageParam;

describe("endOnUserTurn", () => {
	it("leaves a request that ends on a user message alone (same array)", () => {
		const messages: Msg[] = [
			{ role: "system", content: "s" },
			{ role: "user", content: "hi" },
		];
		expect(endOnUserTurn(messages)).toBe(messages);
	});

	it("leaves a tool loop that ends on its tool results alone", () => {
		const messages: Msg[] = [
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "load_skill", arguments: "{}" } },
				],
			},
			{ role: "tool", tool_call_id: "c1", content: "skill text" },
		];
		expect(endOnUserTurn(messages)).toBe(messages);
	});

	it("appends the continue user turn after a trailing assistant message with text", () => {
		const out = endOnUserTurn([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "half an ans" },
		]);
		expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
		expect(out[2].content).toBe(CONTINUE_PROMPT);
	});

	it("drops an empty trailing assistant message", () => {
		const out = endOnUserTurn([
			{ role: "user", content: "hi" },
			{ role: "assistant", content: "" },
		]);
		expect(out).toEqual([{ role: "user", content: "hi" }]);
	});

	it("answers a dangling tool call instead of ending on it", () => {
		const out = endOnUserTurn([
			{ role: "user", content: "run it" },
			{
				role: "assistant",
				content: null,
				tool_calls: [
					{ id: "c1", type: "function", function: { name: "execute_code", arguments: "{}" } },
				],
			},
		]);
		expect(out.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
	});

	it("never ends on an assistant message, whatever the tail", () => {
		const tails: Msg[][] = [
			[{ role: "assistant", content: "x" }],
			[
				{ role: "assistant", content: "x" },
				{ role: "assistant", content: "" },
			],
			[
				{ role: "assistant", content: " " },
				{ role: "assistant", content: "y" },
			],
		];
		for (const tail of tails) {
			const out = endOnUserTurn([{ role: "user", content: "q" }, ...tail]);
			expect(out.at(-1)?.role).not.toBe("assistant");
		}
	});
});
