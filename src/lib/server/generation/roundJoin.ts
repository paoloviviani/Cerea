import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { reapAfterMs } from "./reaper";

/**
 * The join for a tool round (C155).
 *
 * A round is the set of calls the model emitted together. Some of them finish
 * inside the producing run (an MCP call, a builtin); others park the turn and
 * are answered later by someone else: the browser posting an `execute_code`
 * outcome, the user answering an approval, a timer. Each parked call used to
 * resume the turn the moment ITS answer arrived, whatever the siblings were
 * doing: a fast code result woke a second producer while a slow MCP call of
 * the same round was still running in the first, and the resumed turn then ran
 * without that call's result (and the overtaken run's late write was dropped,
 * #301).
 *
 * There is no separate counter to keep: every open call of a round is already
 * durable somewhere that says it is open. This module reads them. A turn may
 * be resumed only when
 *
 *  - no producer is still running it. The producer that dispatched the round
 *    stays alive (heartbeating, see writer.ts) until its last inline call has
 *    a terminal result AND the round is persisted, so its end is the point at
 *    which every inline call is terminal. A producer that dies stops
 *    heartbeating and the reaper closes it, which bounds the wait; a slow call
 *    is bounded by its own timeout.
 *  - no approval prompt of the turn is still unanswered (the deny sweeper
 *    bounds that: an approval expires).
 *
 * Resumption itself is already exactly-once: a parked row is claimed with a
 * compare-and-set on its status, so of several arrivals only the one that finds
 * the round complete AND wins the claim resumes. An arrival that finds the
 * round open leaves its answer recorded (the row keeps its outcome, an answered
 * approval is persisted with the turn) and steps aside; the arrival that closes
 * the round picks everything up, in call order, because a replay pairs results
 * to calls by uuid.
 */

/** How long a deferred resume waits before the sweeper looks at it again. */
export const ROUND_DEFER_MS = 3_000;

/** A running generation whose heartbeat is fresh; a dead one is the reaper's, not ours. */
export async function liveProducerCount(
	conversationId: ObjectId,
	messageId: string
): Promise<number> {
	return collections.generations.countDocuments({
		conversationId,
		messageId,
		status: "running",
		lastHeartbeatAt: { $gte: new Date(Date.now() - reapAfterMs()) },
	});
}

/** Approval prompts of this turn still waiting for the user (an expired one is the deny sweeper's). */
export async function openApprovalCount(conversationId: ObjectId, messageId: string) {
	return collections.mcpElicitations.countDocuments({
		conversationId,
		status: "pending",
		"pending.messageId": messageId,
		$or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
	});
}

/** Why a turn cannot be resumed yet, or null when its round is complete. */
export async function roundBlocker(
	conversationId: ObjectId,
	messageId: string
): Promise<"producer" | "approval" | null> {
	if ((await liveProducerCount(conversationId, messageId)) > 0) return "producer";
	if ((await openApprovalCount(conversationId, messageId)) > 0) return "approval";
	return null;
}

/**
 * A parked row of the turn that will resume it by itself (waiting for its
 * answer, or answered and about to be claimed). An arrival that is not the
 * last one of a round leaves the resume to it.
 */
export async function parkedRowOpen(conversationId: ObjectId, messageId: string) {
	return (
		(await collections.parkedCalls.countDocuments({
			conversationId,
			messageId,
			status: { $in: ["waiting", "resuming"] },
		})) > 0
	);
}

/**
 * Wait until no producer holds the turn, polling. Bounded by the producers'
 * own heartbeats: a live run ends, a dead one is reaped, so this cannot wait
 * forever, and `maxMs` is a backstop.
 */
export async function waitForProducers(
	conversationId: ObjectId,
	messageId: string,
	{
		maxMs = 10 * 60_000,
		pollMs = 250,
		signal,
	}: { maxMs?: number; pollMs?: number; signal?: AbortSignal } = {}
): Promise<boolean> {
	const deadline = Date.now() + maxMs;
	let waited = false;
	while ((await liveProducerCount(conversationId, messageId)) > 0) {
		if (signal?.aborted || Date.now() > deadline) break;
		waited = true;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	if (waited) {
		logger.info(
			{ conversationId: conversationId.toString(), messageId },
			"[round] an answer waited for the round's producer to finish"
		);
	}
	return waited;
}
