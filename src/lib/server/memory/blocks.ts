import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { memoryTail } from "$lib/server/memory/tail";
import type { MemorySnapshot } from "$lib/server/memory/snapshot";

/**
 * Memory in the uncached tail, replayed so the prefix never moves.
 *
 * A provider's prompt cache matches a byte-identical prefix of the request. The
 * memory block (the chat's notes, and personal or project memory changed since
 * the chat's snapshot) must not sit before the newest user message, and it must
 * not *move* either: if turn N carried its block on the newest message and turn
 * N+1 sent that same message without it, the prefix would break at message N.
 * So each user message keeps the block it was sent with (`Message.memoryBlock`,
 * stored with the message) and every later turn replays it unchanged; only the
 * newest message can get a new one.
 *
 * And it is only new when it changed: while the notes stay the same the block
 * rides one message (the first that carried it) and later messages carry none,
 * so a chat does not pay for a copy per turn. If that message is about to fall
 * out of the history window, the block is re-sent on the newest message.
 *
 * A delete drops the stored blocks of the conversations that quote the row
 * (`memory/service.ts`), so a forgotten note does not live on in history.
 */

interface BlockMessage {
	from: string;
	id: string;
	content: string;
	memoryBlock?: string;
}

/**
 * Prefix each user message with its block, without touching anything else. Pure.
 * `blocks` is keyed by position in `messages` (see `blocksByPosition`).
 */
export function applyMemoryBlocks<T extends { from: string; content: string }>(
	messages: T[],
	blocks: ReadonlyMap<number, string>
): T[] {
	if (blocks.size === 0) return messages;
	return messages.map((message, index) => {
		const block = message.from === "user" ? blocks.get(index) : undefined;
		return block ? ({ ...message, content: `${block}\n\n${message.content}` } as T) : message;
	});
}

/**
 * Blocks keyed by id, re-keyed by position in the prepared messages. Preparing a
 * turn's messages is one-to-one except that it may drop an empty first system
 * message, so the prepared list is aligned from the end.
 */
export function blocksByPosition(
	path: { id: string }[],
	preparedLength: number,
	blocksById: ReadonlyMap<string, string>
): Map<number, string> {
	const offset = path.length - preparedLength;
	const out = new Map<number, string>();
	path.forEach((message, index) => {
		const block = blocksById.get(message.id);
		if (block && index - offset >= 0) out.set(index - offset, block);
	});
	return out;
}

/**
 * How far a block's carrier may sit behind the newest message, in characters of history after it,
 * before the block is sent again on the newest message. The history budget trims the oldest
 * messages first, and a block that rode on a trimmed message would silently stop reaching the
 * model, so well before that (a quarter of the default 400,000-character budget, less on a small
 * window) it is re-emitted. A function of the path alone, so it is the same on every replay.
 */
export const REEMIT_SPAN_CHARS = 100_000;

export function reemitSpanFor(contextLengthTokens: number | undefined): number {
	if (!contextLengthTokens || contextLengthTokens <= 0) return REEMIT_SPAN_CHARS;
	// About three characters a token, a quarter of the window.
	return Math.min(REEMIT_SPAN_CHARS, Math.floor(contextLengthTokens * 3 * 0.25));
}

/**
 * The block each user message of this turn's path carries: the ones sent before, replayed from the
 * messages themselves, and, for the newest, a fresh one **only if it differs from the last block
 * on the path** (or the last one has fallen too far behind, `reemitSpanFor`). An unchanged block
 * is stored and sent once; the copy already in the history is the one the model reads. The
 * decision is stored with the message, so a replay reproduces it. Never throws; a store that
 * cannot be read is a worse answer, not none.
 */
export async function prepareMemoryBlocks(options: {
	conversationId: ObjectId;
	/** The turn's path, oldest first (their `memoryBlock` is what was sent before). */
	messages: BlockMessage[];
	/** The conversation's own message list, kept in step so a later whole-array save does not drop the block. */
	conversationMessages?: BlockMessage[];
	snapshot: MemorySnapshot | undefined;
	userId: ObjectId | undefined;
	globalOn: boolean;
	projectId: ObjectId | undefined;
	/** The model's context window in tokens, when known: decides how soon a block is re-sent. */
	contextLengthTokens?: number;
}): Promise<Map<string, string>> {
	const blocks = new Map<string, string>();
	for (const message of options.messages) {
		if (message.from === "user" && message.memoryBlock) blocks.set(message.id, message.memoryBlock);
	}
	const newestIndex = options.messages.findLastIndex((message) => message.from === "user");
	if (newestIndex === -1) return blocks;
	const newest = options.messages[newestIndex];
	try {
		const fresh = await memoryTail(options);
		// The last block sent before the newest message, and the history that has piled up since it.
		let carrier = -1;
		for (let i = newestIndex - 1; i >= 0; i--) {
			const m = options.messages[i];
			if (m.from === "user" && m.memoryBlock) {
				carrier = i;
				break;
			}
		}
		const last = carrier >= 0 ? options.messages[carrier].memoryBlock : undefined;
		const span = options.messages
			.slice(carrier + 1)
			.reduce((chars, message) => chars + message.content.length, 0);
		const emit =
			fresh !== undefined && (fresh !== last || span > reemitSpanFor(options.contextLengthTokens));
		const stored = emit ? fresh : undefined;
		if (stored) blocks.set(newest.id, stored);
		else blocks.delete(newest.id);
		if (newest.memoryBlock !== stored) {
			newest.memoryBlock = stored;
			const own = options.conversationMessages?.find((message) => message.id === newest.id);
			if (own) own.memoryBlock = stored;
			await collections.conversations.updateOne(
				{ _id: options.conversationId, "messages.id": newest.id },
				stored
					? { $set: { "messages.$.memoryBlock": stored } }
					: { $unset: { "messages.$.memoryBlock": "" } }
			);
		}
	} catch (err) {
		logger.warn({ err: String(err) }, "memory_blocks_degraded: answering without the fresh block");
	}
	return blocks;
}
