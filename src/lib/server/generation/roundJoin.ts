import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
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
 *  - no approval of the turn is still open. An approval is open from the
 *    moment its prompt is shown until its RESULT is applied to the turn:
 *    unanswered (it expires, the deny sweeper bounds it) and answered but not
 *    yet consumed (`consumedAt`; the answer is resumed by the server through a
 *    parked row of kind `approval`, never by the browser, so the call runs
 *    even when the tab is gone).
 *  - no other parked row of the turn is open (a sibling that is still due).
 *
 * No path blocks on this: a resume that finds the round open gives its claim back
 * and the sweeper tries again later, with a growing delay.
 *
 * Resumption itself is already exactly-once: a parked row is claimed with a
 * compare-and-set on its status, so of several arrivals only the one that finds
 * the round complete AND wins the claim resumes. An arrival that finds the
 * round open leaves its answer recorded (the row keeps its outcome, an answered
 * approval is persisted with the turn) and steps aside; the arrival that closes
 * the round picks everything up, in call order, because a replay pairs results
 * to calls by uuid.
 */

/** Delay before a deferred resume is looked at again: 3 s, doubling per deferral, 60 s at most. */
export function deferDelayMs(deferrals: number): number {
	return Math.min(60_000, 3_000 * 2 ** Math.min(deferrals, 5));
}

/** An answered approval whose result never landed stops holding the round after this long. */
const UNCONSUMED_APPROVAL_MS = 15 * 60_000;

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

/**
 * Tool approvals of this turn that are still open: unanswered (not expired), or
 * answered and not yet consumed. `except` is the approval the caller is itself
 * about to apply.
 */
export async function openApprovalCount(
	conversationId: ObjectId,
	messageId: string,
	except?: string
): Promise<number> {
	const now = new Date();
	return collections.mcpElicitations.countDocuments({
		conversationId,
		"pending.messageId": messageId,
		"pending.kind": "tool-approval",
		...(except ? { elicitationId: { $ne: except } } : {}),
		$or: [
			{
				status: "pending",
				$or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: now } }],
			},
			{
				status: "resolved",
				consumedAt: { $exists: false },
				resolvedAt: { $gt: new Date(now.getTime() - UNCONSUMED_APPROVAL_MS) },
			},
		],
	});
}

/** Other parked rows of the turn that will resume it or still hold it (waiting or being resumed). */
export async function otherParkedRows(
	conversationId: ObjectId,
	messageId: string,
	exceptRowId?: ObjectId
): Promise<number> {
	return collections.parkedCalls.countDocuments({
		conversationId,
		messageId,
		status: { $in: ["waiting", "resuming"] },
		...(exceptRowId ? { _id: { $ne: exceptRowId } } : {}),
	});
}

/** Why a turn cannot be resumed yet, or null when its round is complete. */
export async function roundBlocker(
	conversationId: ObjectId,
	messageId: string,
	self?: { rowId?: ObjectId; elicitationId?: string }
): Promise<"producer" | "approval" | "sibling" | null> {
	if ((await liveProducerCount(conversationId, messageId)) > 0) return "producer";
	// An approval's own resume only APPLIES its result (it never runs the model while the round
	// has other calls open), so it needs the producer gone and nothing more.
	if (self?.elicitationId) return null;
	if ((await openApprovalCount(conversationId, messageId, self?.elicitationId)) > 0)
		return "approval";
	if ((await otherParkedRows(conversationId, messageId, self?.rowId)) > 0) return "sibling";
	return null;
}

/**
 * Record that a tool approval was answered so the SERVER applies it: a parked
 * row of kind `approval`, due now. The sweeper runs the approved call (or
 * records the refusal) and, when the round is complete, the model. Idempotent on
 * the elicitation id, so the answer endpoint and the deny sweeper cannot queue
 * it twice.
 */
export async function queueApprovalResume(row: {
	elicitationId: string;
	conversationId: ObjectId;
	generationId?: string;
	pending: { messageId: string; toolCallId: string; toolUuid: string; tool?: string } & {
		userId?: ObjectId;
		sessionId?: string;
	};
}): Promise<void> {
	const now = new Date();
	await collections.parkedCalls.updateOne(
		{ parkedCallId: row.elicitationId, kind: "approval" },
		{
			$setOnInsert: {
				_id: new ObjectId(),
				parkedCallId: row.elicitationId,
				conversationId: row.conversationId,
				...(row.generationId ? { generationId: row.generationId } : {}),
				messageId: row.pending.messageId,
				toolCallId: row.pending.toolCallId,
				toolUuid: row.pending.toolUuid,
				kind: "approval",
				status: "waiting",
				resumeAt: now,
				reason: `tool approval${row.pending.tool ? `: ${row.pending.tool}` : ""}`,
				...(row.pending.userId ? { userId: row.pending.userId } : {}),
				...(row.pending.sessionId ? { sessionId: row.pending.sessionId } : {}),
				attempts: 0,
				createdAt: now,
				updatedAt: now,
			},
		},
		{ upsert: true }
	);
}

/**
 * One-off at startup, for the upgrade: an approval answered on the code that preceded server-side
 * application (resolved, never consumed, no parked row) would otherwise be lost, because a
 * browser's resume request for it is now refused. Queues the row for each such approval answered
 * in the last 24 hours; idempotent, and cheap when there are none.
 */
export async function backfillApprovalResumes(): Promise<number> {
	const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const rows = await collections.mcpElicitations
		.find({
			status: "resolved",
			"pending.kind": "tool-approval",
			consumedAt: { $exists: false },
			resolvedAt: { $gte: since },
		})
		.limit(500)
		.toArray();
	let queued = 0;
	for (const row of rows) {
		const pending = row.pending;
		if (!pending || pending.kind !== "tool-approval") continue;
		const exists = await collections.parkedCalls.countDocuments({
			parkedCallId: row.elicitationId,
		});
		if (exists > 0) continue;
		await queueApprovalResume({
			elicitationId: row.elicitationId,
			conversationId: row.conversationId,
			...(row.generationId ? { generationId: row.generationId } : {}),
			pending,
		});
		queued += 1;
	}
	return queued;
}
