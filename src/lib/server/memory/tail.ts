import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import {
	conversationMemoryContext,
	listMemories,
	listProjectMemories,
} from "$lib/server/memory/service";
import {
	memoryUpdatesBlock,
	snapshotApplies,
	type MemorySnapshot,
} from "$lib/server/memory/snapshot";

/**
 * Everything memory-shaped that goes in the uncached tail of a request: the
 * chat's own notes, then whatever personal or project memory changed since the
 * chat's snapshot. `undefined` when there is nothing to say. Never throws: a
 * store that cannot be read is a reason for a worse answer, not for none.
 *
 * The system prompt carries the snapshot (`memory/snapshot`) and nothing live,
 * so this is the only place a memory write can show up mid-conversation.
 */
export async function memoryTail(options: {
	conversationId: ObjectId;
	snapshot: MemorySnapshot | undefined;
	userId: ObjectId | undefined;
	globalOn: boolean;
	projectId: ObjectId | undefined;
}): Promise<string | undefined> {
	const parts: string[] = [];
	const notes = await conversationMemoryContext(options.conversationId);
	if (notes) parts.push(notes);
	try {
		const available = {
			userId: options.userId,
			globalOn: options.globalOn,
			projectId: options.projectId,
		};
		if (options.userId && snapshotApplies(options.snapshot, available)) {
			const [global, project] = await Promise.all([
				options.globalOn ? listMemories(options.userId) : undefined,
				options.projectId ? listProjectMemories(options.projectId) : undefined,
			]);
			const updates = memoryUpdatesBlock(options.snapshot, { global, project });
			if (updates) parts.push(updates);
		}
	} catch (err) {
		logger.warn({ err: String(err) }, "memory_updates_degraded: answering without them");
	}
	return parts.length > 0 ? parts.join("\n\n") : undefined;
}
