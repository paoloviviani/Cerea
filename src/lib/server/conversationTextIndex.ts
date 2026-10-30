/**
 * The text index behind message-content search on `/chats`.
 *
 * One per collection is all MongoDB allows, so this is the only text index on
 * `conversations`. Titles weigh ten times a message, so a conversation titled
 * with the word outranks one that merely mentions it. `default_language:
 * "none"` turns stemming and stop words off: the same index serves Italian and
 * English, and a word matches only as itself. Text index v3 folds case and
 * diacritics, so `perche` finds "perché".
 *
 * `messages.content` is the text a user wrote and the answer shown to them.
 * Reasoning, tool calls and results (`updates`), and attachments (`files`)
 * are other fields and are not indexed.
 */

/**
 * `userId` leads, so a `$text` query that names one user (every one does) reads
 * only that user's entries rather than every match in the collection. Visitors
 * without an account (no `userId`) are not searched by content.
 */
export const CONVERSATION_TEXT_INDEX_KEYS = {
	userId: 1,
	title: "text",
	"messages.content": "text",
} as const;

export const CONVERSATION_TEXT_INDEX_OPTIONS = {
	name: "conversations_user_text",
	weights: { title: 10, "messages.content": 1 },
	default_language: "none",
	textIndexVersion: 3,
	background: true,
} as const;
