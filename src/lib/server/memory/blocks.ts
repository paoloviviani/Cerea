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
 * newest message gets a freshly rendered one.
 *
 * The cost is honest: a chat with notes sends a copy of the block per user
 * message it is still carrying. The block is capped (notes 3,000 characters,
 * updates 3,000) and exists only when there is something to say.
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
 * The block each user message of this turn's path carries: the ones sent before,
 * replayed from the messages themselves, and a fresh one for the newest, which is
 * stored with it. Never throws; a store that cannot be read is a worse answer,
 * not none.
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
}): Promise<Map<string, string>> {
	const blocks = new Map<string, string>();
	for (const message of options.messages) {
		if (message.from === "user" && message.memoryBlock) blocks.set(message.id, message.memoryBlock);
	}
	const newest = options.messages.findLast((message) => message.from === "user");
	if (!newest) return blocks;
	try {
		const fresh = await memoryTail(options);
		if (fresh) blocks.set(newest.id, fresh);
		else blocks.delete(newest.id);
		if (newest.memoryBlock !== fresh) {
			newest.memoryBlock = fresh;
			const own = options.conversationMessages?.find((message) => message.id === newest.id);
			if (own) own.memoryBlock = fresh;
			await collections.conversations.updateOne(
				{ _id: options.conversationId, "messages.id": newest.id },
				fresh
					? { $set: { "messages.$.memoryBlock": fresh } }
					: { $unset: { "messages.$.memoryBlock": "" } }
			);
		}
	} catch (err) {
		logger.warn({ err: String(err) }, "memory_blocks_degraded: answering without the fresh block");
	}
	return blocks;
}
