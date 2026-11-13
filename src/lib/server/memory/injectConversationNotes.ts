import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * Put a chat's notes block at the head of the newest user message.
 *
 * Why there, and not in the system prompt: a provider's prompt cache matches
 * on a byte-identical prefix. Anything that changes between turns and sits
 * early in the request throws away the cache for all the history after it.
 * The newest user message is new tokens on every turn anyway, so a block that
 * rides in front of it costs nothing extra to change, and every message before
 * it is untouched. Nothing is added to the system message or the tool list.
 *
 * Returns the same array when there is nothing to inject or no user message to
 * carry it. Never mutates its input.
 */
export function injectConversationNotes(
	messages: ChatCompletionMessageParam[],
	block: string | undefined
): ChatCompletionMessageParam[] {
	if (!block) return messages;
	const index = messages.findLastIndex((message) => message.role === "user");
	if (index === -1) return messages;
	const target = messages[index];
	if (target.role !== "user") return messages;
	const updated = [...messages];
	if (typeof target.content === "string") {
		updated[index] = { ...target, content: `${block}\n\n${target.content}` };
	} else if (Array.isArray(target.content)) {
		updated[index] = { ...target, content: [{ type: "text", text: block }, ...target.content] };
	} else {
		return messages;
	}
	return updated;
}
