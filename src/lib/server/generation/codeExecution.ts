import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { CodeExecutionOutcome } from "$lib/types/ParkedCall";

/**
 * The browser-side answer channel for parked `execute_code` calls — parallel to
 * the elicitation answer path, never touching elicitation semantics.
 *
 * The browser runs the code in its own ExecutionSession and posts the outcome
 * here. Recording it follows the wake pattern (see `wakeParkedCallEarly`):
 * moving `resumeAt` to now is the ENTIRE state change. The row stays
 * `waiting`, so the ordinary sweep claim still decides which pod resumes the
 * turn — a racing sweeper cannot produce a second producer, and the row is
 * picked up by the sweep within one interval even when no client triggers the
 * resume itself. The caller kicks a sweep afterwards purely so the person does
 * not sit through the sweep interval (same as the wake endpoint).
 */
export type CodeExecutionSubmitResult =
	| { ok: true; resume: boolean; messageId?: string }
	| { ok: false; status: 404 | 409 | 500; error: string };

export async function submitCodeExecutionResult({
	executionId,
	conversationId,
	outcome,
}: {
	executionId: string;
	conversationId: ObjectId;
	outcome: CodeExecutionOutcome;
}): Promise<CodeExecutionSubmitResult> {
	// Scoped by conversation: holding an execution id is not authority to answer
	// someone else's run.
	const doc = await collections.parkedCalls.findOne({
		parkedCallId: executionId,
		conversationId,
		kind: "code",
	});
	if (!doc) return { ok: false, status: 404, error: "Unknown code execution." };

	// CAS-first, atomic: only the FIRST answer writes the outcome (a second
	// submit is a no-op, not a second, different answer), and moving `resumeAt`
	// to now is the ENTIRE state change (the wake pattern) — the row stays
	// `waiting`, so the ordinary sweep claim still decides which pod resumes.
	// A late answer that the sweep has not claimed yet is still accepted: the
	// real result beats the sweeper's unavailable fallback.
	const now = new Date();
	const claimed = await collections.parkedCalls.findOneAndUpdate(
		{
			_id: doc._id,
			status: "waiting",
			outcome: { $exists: false },
		},
		{ $set: { outcome, resumeAt: now, updatedAt: now } }
	);
	if (!claimed?.value) {
		// Answered already, or claimed/resumed by the sweeper in the meantime:
		// there is nothing left to answer.
		return { ok: false, status: 409, error: "Already answered." };
	}

	logger.info(
		{
			parkedCallId: executionId,
			conversationId: conversationId.toString(),
			ok: outcome.ok,
			files: outcome.files?.length ?? 0,
		},
		"[execute_code] browser posted the run outcome; parked turn woken"
	);

	return { ok: true, resume: true, messageId: doc.messageId };
}
