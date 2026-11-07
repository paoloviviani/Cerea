import { isUnlistedForUsers } from "$lib/server/hiddenModels";
import { config } from "$lib/server/config";
import { generateFromDefaultEndpoint } from "$lib/server/generateFromDefaultEndpoint";
import { isCustomModelId } from "$lib/utils/customModelId";
import { logger } from "$lib/server/logger";
import { MessageUpdateType, type MessageUpdate } from "$lib/types/MessageUpdate";
import type { Conversation } from "$lib/types/Conversation";
import { getReturnFromGenerator } from "$lib/utils/getReturnFromGenerator";
import { stripThink } from "$lib/utils/stripThink";
import { pickTitleModel, storedTitleModel, type TitleModelCandidate } from "$lib/server/titleModel";
import { fallbackTitle } from "./titleFallback";

/** Times a model is asked to title one chat: the first message, the first reply, one more turn. */
export const MAX_TITLE_ATTEMPTS = 3;

/** How much of the user's message and of the reply the title prompt sees. */
const PROMPT_CHARS = 1500;
const REPLY_CHARS = 600;

/** Token budgets: a small one, then one larger try when only reasoning came back. */
const TOKEN_BUDGETS = [64, 512];

/** A title is never worth holding the turn's stream open for longer than this. */
const ATTEMPT_TIMEOUT_MS = 30_000;

const NEW_CHAT = "New Chat";

/** The first non-empty assistant reply: what a retry shows the model besides the question. */
function firstReply(conv: Conversation): string | undefined {
	const reply = conv.messages.find((m) => m.from === "assistant" && m.content.trim());
	return reply ? stripThink(reply.content).trim().slice(0, REPLY_CHARS) || undefined : undefined;
}

/**
 * Names the conversation, and tries again when the first try could only fall
 * back to a trimmed sentence. The first attempt runs on the first message. If
 * it falls back, `afterReply` (resolving when the first reply is complete)
 * triggers a second attempt that also sees the start of that reply; if that
 * falls back too, the next turn tries once more. Then it stops. A title the
 * user typed is never touched.
 */
export async function* generateTitleForConversation(
	conv: Conversation,
	locals: App.Locals | undefined,
	opts: { afterReply?: Promise<unknown> } = {}
): AsyncGenerator<MessageUpdate, undefined, undefined> {
	try {
		const userMessage = conv.messages.find((m) => m.from === "user");
		if (!userMessage || conv.titleSource === "user") return;

		const prompt = userMessage.content;
		const summarize = config.LLM_SUMMARIZATION === "true";
		// HACK: a conversation is new while it still has the placeholder title.
		const fresh = conv.title === NEW_CHAT && !conv.titleSource;
		const retry = summarize && conv.titleSource === "fallback";
		if (!fresh && !retry) return;

		if (!summarize) {
			// No model call at all: nothing to retry.
			yield { type: MessageUpdateType.Title, title: fallbackTitle(prompt), source: "model" };
			return;
		}

		let title = conv.title;
		let attempts = conv.titleAttempts ?? 0;
		let waitForReply = fresh ? opts.afterReply : undefined;

		// The first message (or, on a later turn, a retry that can use the reply),
		// then, in the same turn, one more once the reply is complete.
		for (;;) {
			if (attempts >= MAX_TITLE_ATTEMPTS) return;
			const generated = await attemptTitle(conv, prompt, firstReply(conv), locals);
			attempts += 1;
			if (generated) {
				yield { type: MessageUpdateType.Title, title: generated, source: "model", attempts };
				return;
			}
			// A fallback only replaces the placeholder; a retry keeps what is shown.
			if (title === NEW_CHAT) title = fallbackTitle(prompt);
			yield { type: MessageUpdateType.Title, title, source: "fallback", attempts };
			if (!waitForReply) return;
			await waitForReply;
			waitForReply = undefined;
			if (!firstReply(conv)) return;
		}
	} catch (cause) {
		logger.error(cause, "Failed while generating title for conversation");
	}
}

export type RegenerateTitleResult =
	{ ok: true; title: string } | { ok: false; reason: "user-title" | "no-messages" | "unavailable" };

/**
 * "Regenerate title" in a chat's menu: ask the title model again, now with the
 * start of the reply to read. The caller saves the result (conditionally, see
 * `saveGeneratedTitle`).
 *
 * Never on a title the user typed (`titleSource: "user"`): refused up front, and
 * the caller's write is conditional on it too, so a rename that lands while the
 * model is thinking still wins. It does not count against the automatic
 * attempts (`MAX_TITLE_ATTEMPTS`): that budget is for chats nobody has asked
 * about. Where titles are not model-written (`LLM_SUMMARIZATION` off) or the
 * model gives nothing in time, nothing is returned and the title stays as it
 * is, rather than "regenerating" to the same trimmed sentence.
 */
export async function regenerateTitle(
	conv: Conversation,
	locals: App.Locals | undefined
): Promise<RegenerateTitleResult> {
	if (conv.titleSource === "user") return { ok: false, reason: "user-title" };
	const userMessage = conv.messages.find((m) => m.from === "user");
	if (!userMessage) return { ok: false, reason: "no-messages" };
	if (config.LLM_SUMMARIZATION !== "true") return { ok: false, reason: "unavailable" };

	const generated = await attemptTitle(conv, userMessage.content, firstReply(conv), locals);
	return generated ? { ok: true, title: generated } : { ok: false, reason: "unavailable" };
}

/** The catalogue as title-model candidates; empty when it cannot be read. */
async function catalogue(): Promise<TitleModelCandidate[]> {
	try {
		const { models } = await import("$lib/server/models");
		return models.map((m) => ({
			id: m.id,
			name: m.name,
			supportsReasoning: m.supportsReasoning,
			unlisted: isUnlistedForUsers(m),
		}));
	} catch {
		return [];
	}
}

/**
 * Never the custom id, which the gateway has not heard of, and never the
 * person's prompts: a title is an internal completion, not a chat turn.
 */
async function titleModelFor(conv: Conversation): Promise<string> {
	const convModel = isCustomModelId(conv.model) ? await baseModelOf(conv) : conv.model;
	return pickTitleModel({
		stored: storedTitleModel(),
		env: config.TASK_MODEL,
		convModel,
		catalogue: await catalogue(),
	});
}

/** Loaded on demand: only a custom model needs the database to name its base. */
async function baseModelOf(conv: Conversation): Promise<string> {
	const { baseModelIdFor, conversationOwnerFilter } = await import("$lib/server/customModels");
	return baseModelIdFor(conv.model, conversationOwnerFilter(conv));
}

/** A model's title for the chat, or undefined when it gave none in time. */
async function attemptTitle(
	conv: Conversation,
	prompt: string,
	reply: string | undefined,
	locals: App.Locals | undefined
): Promise<string | undefined> {
	const work = (async () => {
		const modelId = await titleModelFor(conv);
		for (const budget of TOKEN_BUDGETS) {
			const title = await runTitleModel(prompt, reply, modelId, budget, locals);
			if (title) return title;
		}
		return undefined;
	})();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), ATTEMPT_TIMEOUT_MS);
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		clearTimeout(timer);
	}
}

async function runTitleModel(
	prompt: string,
	reply: string | undefined,
	modelId: string,
	maxTokens: number,
	locals: App.Locals | undefined
): Promise<string | undefined> {
	const content =
		`User message: "${prompt.slice(0, PROMPT_CHARS)}"` +
		(reply ? `\n\nStart of the assistant's reply: "${reply}"` : "");
	try {
		const summary = await getReturnFromGenerator(
			generateFromDefaultEndpoint({
				messages: [{ from: "user", content }],
				preprompt: `You are a chat thread titling assistant.
Goal: Produce a very short, descriptive title (2–4 words) that names the topic of the user's first message.

Rules:
- Output ONLY the title text. No prefixes, labels, quotes, emojis, hashtags, or trailing punctuation.
- Write the title in the language of the user's message (a message in Italian gets an Italian title), whatever language these instructions or the assistant's reply are in.
- Write a noun phrase that names the topic. Do not write instructions.
- Never output just a pronoun (me/you/I/we/us/myself/yourself). Prefer a neutral subject (e.g., "Assistant", "model", or the concrete topic).
- Never include meta-words: Summarize, Summary, Title, Prompt, Topic, Subject, About, Question, Request, Chat.
- If the assistant's reply is shown, use it only to understand the topic. The title still names what the user asked about.

Examples:
User: "Summarize hello" -> Hello
User: "How do I reverse a string in Python?" -> Python string reversal
User: "help me plan a NYC weekend" -> NYC weekend plan
User: "Quanti giorni lavorativi ci sono in Italia?" -> Giorni lavorativi in Italia
User: "请解释Transformer是如何工作的" -> Transformer 工作原理
User: "tell me more about you" -> About the assistant
Return only the title text.`,
				generateSettings: {
					// A reasoning model needs room to finish thinking AND emit the
					// title. The first try is small; `attemptTitle` makes one larger
					// try when only reasoning came back.
					max_tokens: maxTokens,
					temperature: 0,
				},
				// Unthrottled, a reasoning model spends the whole token budget
				// thinking and returns no content. `low` keeps the thinking short
				// enough that the title usually completes; non-reasoning models
				// ignore the parameter.
				reasoningEffort: "low",
				modelId,
				locals,
			})
		);
		// An unterminated think block (the budget spent thinking) strips to
		// nothing, so it counts as no title rather than showing the trace.
		const first = stripThink(String(summary ?? ""))
			.trim()
			.split("\n")[0]
			?.trim()
			.replace(/^["'“”«]+|["'“”»]+$/g, "")
			.trim();
		return first ? first.slice(0, 100) : undefined;
	} catch (e) {
		logger.error(e, "Error generating title");
		return undefined;
	}
}
