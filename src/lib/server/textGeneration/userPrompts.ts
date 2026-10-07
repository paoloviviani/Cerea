import { collections } from "$lib/server/database";
import { conversationOwnerFilter, resolveConversationModel } from "$lib/server/customModels";
import { logger } from "$lib/server/logger";
import type { Conversation } from "$lib/types/Conversation";

/**
 * The two prompts a person writes themselves, for one chat turn: their global
 * system prompt and, when the conversation is on a custom model, that model's.
 * Never fails a turn: like memory and project context, a store that cannot be
 * read is a reason for a turn without them, not for no turn.
 */
export async function userPromptsFor(
	conv: Pick<Conversation, "model" | "userId" | "sessionId">
): Promise<{ globalPrompt?: string; customModelPrompt?: string }> {
	const owner = conversationOwnerFilter(conv);
	if (!owner) return {};
	try {
		const [settings, resolved] = await Promise.all([
			collections.settings.findOne(owner as never, { projection: { globalSystemPrompt: 1 } }),
			resolveConversationModel(conv.model, owner),
		]);
		return {
			globalPrompt: settings?.globalSystemPrompt,
			customModelPrompt: resolved?.custom?.systemPrompt,
		};
	} catch (err) {
		logger.warn(
			{ err: String(err) },
			"[custom-models] user prompts failed; continuing without them"
		);
		return {};
	}
}
