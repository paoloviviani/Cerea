import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { config } from "$lib/server/config";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { submitCodeExecutionResult } from "$lib/server/generation/codeExecution";
import { codePausedWaitMs } from "./deadlines";
import type { ExecutionBackend, PauseResult } from "./backend";
import {
	MessageCodeExecutionUpdateType,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";

/**
 * Keep a pending parked `code` call alive while its page is in the background.
 *
 * The first signal stamps `pausedAt`; the deadline becomes `now + wait` but is
 * never moved earlier than it already is, and never past `pausedAt + wait`, so a
 * page that keeps signalling cannot hold the turn forever. One atomic pipeline
 * update, filtered on a still-waiting row with no outcome: a call the sweeper
 * already claimed or the browser already answered is left alone (409).
 */
export async function extendCodeDeadlineForPause(
	conversationId: ObjectId,
	executionId: string,
	now: Date = new Date()
): Promise<PauseResult> {
	const wait = codePausedWaitMs();
	const updated = await collections.parkedCalls.findOneAndUpdate(
		{
			parkedCallId: executionId,
			conversationId,
			kind: "code",
			status: "waiting",
			outcome: { $exists: false },
		},
		[
			{ $set: { pausedAt: { $ifNull: ["$pausedAt", now] } } },
			{
				$set: {
					resumeAt: {
						$max: ["$resumeAt", { $min: [{ $add: [now, wait] }, { $add: ["$pausedAt", wait] }] }],
					},
					updatedAt: now,
				},
			},
		] as never,
		{ returnDocument: "after" }
	);
	const doc = updated?.value;
	if (!doc) {
		const exists = await collections.parkedCalls.findOne(
			{ parkedCallId: executionId, conversationId, kind: "code" },
			{ projection: { _id: 1 } }
		);
		return exists
			? { ok: false, status: 409, error: "Not waiting any more." }
			: { ok: false, status: 404, error: "Unknown code execution." };
	}
	logger.info(
		{ parkedCallId: executionId, resumeAt: doc.resumeAt.toISOString() },
		"[execute_code] the page paused; the parked call keeps waiting"
	);
	return { ok: true, resumeAt: doc.resumeAt };
}

/**
 * The browser backend: the turn parks on the person's page (`parkedCalls`,
 * kind `code`), the code streams there, their ExecutionSession runs it, and the
 * page posts the outcome back to the resolve endpoint.
 */
export const browserBackend: ExecutionBackend = {
	kind: "browser",
	enabled: true,
	toolOffered: () => config.CHAT_CODE_TOOL_ENABLED === "true",
	supportsUnattended: false,
	supportsPause: true,
	promptEngine: "in the person's browser (Pyodide, WebAssembly)",

	async startRun({ call, code, limits }, emit: (update: MessageUpdate) => void) {
		const executionId = randomUUID();
		const now = new Date();
		const expiresAt = new Date(now.getTime() + limits.deadlineMs);
		await collections.parkedCalls.insertOne({
			_id: new ObjectId(),
			parkedCallId: executionId,
			conversationId: call.conversationId,
			...(call.generationId ? { generationId: call.generationId } : {}),
			messageId: call.messageId,
			toolCallId: call.toolCallId,
			toolUuid: call.toolUuid,
			kind: "code",
			status: "waiting",
			resumeAt: expiresAt,
			reason: "code execution in the person's browser",
			code,
			...(call.userId ? { userId: call.userId } : {}),
			...(call.sessionId ? { sessionId: call.sessionId } : {}),
			attempts: 0,
			createdAt: now,
			updatedAt: now,
		});
		// The code streams to the person's browser over the same channel
		// elicitation uses; their ExecutionSession runs it and posts the
		// outcome back to the resolve endpoint, which wakes the parked row.
		emit({
			type: MessageUpdateType.CodeExecution,
			subtype: MessageCodeExecutionUpdateType.Request,
			executionId,
			code,
			toolUuid: call.toolUuid,
			expiresAt: expiresAt.getTime(),
		});
		return { executionId, expiresAt };
	},

	pause: extendCodeDeadlineForPause,

	resolve(conversationId, executionId, outcome) {
		return submitCodeExecutionResult({ executionId, conversationId, outcome });
	},
};
