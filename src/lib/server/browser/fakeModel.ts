/**
 * A scripted model for the browsing loop's tests: a list of turns, played in order, each either a
 * fixed answer or a function of the messages so far (to assert on what the model was shown).
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { OpenAiTool } from "$lib/server/mcp/tools";
import type { CompleteFn, ModelTurn } from "./loop";

export type ScriptedTurn =
	| ModelTurn
	| ((request: { messages: ChatCompletionMessageParam[]; tools?: OpenAiTool[] }) => ModelTurn);

export interface ScriptedModel {
	complete: CompleteFn;
	/** Every request the loop made, in order. */
	requests: Array<{ messages: ChatCompletionMessageParam[]; tools?: OpenAiTool[] }>;
}

export function scriptedModel(script: ScriptedTurn[]): ScriptedModel {
	const requests: ScriptedModel["requests"] = [];
	let at = 0;
	return {
		requests,
		complete: async (request) => {
			requests.push({ messages: [...request.messages], tools: request.tools });
			const next = script[Math.min(at, script.length - 1)];
			at += 1;
			if (!next) throw new Error("the script is empty");
			return typeof next === "function" ? next(request) : next;
		},
	};
}

let counter = 0;

/** A turn that calls one tool. */
export function callTurn(name: string, args: unknown, tokens = 100): ModelTurn {
	counter += 1;
	return {
		content: null,
		toolCalls: [{ id: `call_${counter}`, name, arguments: JSON.stringify(args) }],
		finishReason: "tool_calls",
		totalTokens: tokens,
	};
}

/** A turn that answers, ending the loop. */
export function answerTurn(text: string, tokens = 100): ModelTurn {
	return { content: text, toolCalls: [], finishReason: "stop", totalTokens: tokens };
}

/** The text of every tool message of a request, for assertions. */
export function toolTexts(messages: ChatCompletionMessageParam[]): string[] {
	return messages.flatMap((m) =>
		m.role === "tool" && typeof m.content === "string" ? [m.content] : []
	);
}
