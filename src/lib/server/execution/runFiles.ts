import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { Message } from "$lib/types/Message";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageCodeExecutionOutputsUpdate,
} from "$lib/types/MessageUpdate";

/**
 * A generous but bounded ceiling on how many run-file records one
 * conversation can accumulate (each record is one run's file listing, not one
 * file — see `MAX_DELIVERABLES_PER_CONVERSATION` for the bytes-store cap).
 * Past this, a runaway loop that keeps "running" would otherwise grow this
 * collection without limit.
 */
export const MAX_CODE_RUN_FILES_PER_CONVERSATION = 1000;

/**
 * Serve a conversation's messages with the stored output files of its code
 * blocks and artifact cells attached, as `CodeExecution/Outputs` updates on
 * the assistant message each run belongs to.
 *
 * Decorated on the way out rather than stored on the message, because a turn
 * saves `messages` wholesale (see CodeRunFiles.ts). Everything downstream —
 * the file artifacts, the sidebar, a replayed block, the export — then reads
 * one shape for every produced file, whichever path produced it.
 *
 * Best effort: a failed lookup serves the messages as they are, since a
 * missing file card is a worse answer than none only if it takes the
 * conversation down with it.
 */
export async function withRunFiles(
	conversationId: ObjectId | string,
	messages: Message[]
): Promise<Message[]> {
	let records;
	try {
		records = await collections.codeRunFiles
			.find({ conversationId: new ObjectId(conversationId) })
			.sort({ createdAt: 1 })
			.toArray();
	} catch (err) {
		logger.warn({ err }, "code_run_files_lookup_failed");
		return messages;
	}
	if (records.length === 0) return messages;

	const byMessage = new Map<string, MessageCodeExecutionOutputsUpdate[]>();
	for (const record of records) {
		const list = byMessage.get(record.messageId) ?? [];
		list.push({
			type: MessageUpdateType.CodeExecution,
			subtype: MessageCodeExecutionUpdateType.Outputs,
			runKey: record.runKey,
			files: record.files,
		});
		byMessage.set(record.messageId, list);
	}

	return messages.map((message) => {
		const extra = message.from === "assistant" ? byMessage.get(message.id) : undefined;
		return extra ? { ...message, updates: [...(message.updates ?? []), ...extra] } : message;
	});
}
