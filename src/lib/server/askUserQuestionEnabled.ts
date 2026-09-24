import { config } from "$lib/server/config";

/**
 * Whether `ask_user_question` joins every conversation, not only the ML
 * Assistant preset: the deployment switch `CHAT_ASK_USER_QUESTION_ENABLED`, on
 * unless explicitly `"false"`. A structured question with clickable options is
 * as useful to an ordinary chat as to a mode one; the switch is the operator's
 * way to keep a model that over-asks, or cannot call tools reliably, out of it.
 */
export function askUserQuestionEnabled(): boolean {
	return config.CHAT_ASK_USER_QUESTION_ENABLED !== "false";
}
