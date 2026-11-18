import type { OpenAI } from "openai";
import { logger } from "$lib/server/logger";

type ChatMessageParam = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/**
 * The user turn that asks the model to go on after a turn that stopped part-way.
 * Sent as a real user message, never as an assistant prefill: recent Anthropic
 * models reject a request whose last message is the assistant's
 * ("This model does not support assistant message prefill. The conversation
 * must end with a user message."), and no other provider is helped by one.
 */
export const CONTINUE_PROMPT = "Continue from where you stopped.";

const INTERRUPTED = "Error: interrupted before a result was recorded";

function isBlank(content: ChatMessageParam["content"]): boolean {
	if (content === null || content === undefined) return true;
	if (typeof content === "string") return content.trim().length === 0;
	if (Array.isArray(content)) return content.length === 0;
	return false;
}

/**
 * Guarantees that a request never ends with an assistant message. This app
 * never intends a prefill, so a trailing assistant message is always a bug
 * upstream of here (a failed partial turn replayed last, a loop round that
 * stopped before its tool results), and sending it would fail the whole
 * request on a provider that rejects prefill.
 *
 * - An empty trailing assistant message (a failed turn that produced nothing)
 *   is dropped.
 * - A trailing assistant message with tool calls and no results gets an
 *   "interrupted" result per call, so the calls are answered.
 * - A trailing assistant message with text gets the continue user turn after it.
 *
 * Returns the input untouched when it already ends on a user or tool message.
 * Logs a warning whenever it has to change anything.
 */
export function endOnUserTurn(messages: ChatMessageParam[], context?: string): ChatMessageParam[] {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "assistant") return messages;

	const out = [...messages];
	const fixes: string[] = [];
	for (;;) {
		const tail = out[out.length - 1];
		if (!tail || tail.role !== "assistant") break;
		const calls = "tool_calls" in tail ? (tail.tool_calls ?? []) : [];
		if (calls.length > 0) {
			for (const call of calls) {
				out.push({ role: "tool", tool_call_id: call.id, content: INTERRUPTED });
			}
			fixes.push("answered dangling tool calls");
			break;
		}
		if (isBlank(tail.content)) {
			out.pop();
			fixes.push("dropped an empty trailing assistant message");
			continue;
		}
		out.push({ role: "user", content: CONTINUE_PROMPT });
		fixes.push("appended the continue user turn");
		break;
	}
	if (out.length > 0 && out[out.length - 1].role === "system") {
		// Nothing but a system prompt is left: there is no conversation to answer.
		return messages;
	}
	logger.warn(
		{ context, fixes },
		"[request] the outgoing messages ended with an assistant message; fixed before sending"
	);
	return out;
}
