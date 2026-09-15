import type { ObjectId } from "mongodb";
import type { Conversation } from "./Conversation";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";
import type { RunOutcome, RuntimeFile } from "$lib/utils/execution/protocol";

/** Full outcome a browser run reports back, with the files it created (the sweeper names them in the tool result). */
export type CodeExecutionOutcome = RunOutcome & { files: RuntimeFile[] };

/**
 * Why a turn is parked. `timer` is the clock kind: the model asked to be
 * woken after a delay instead of re-polling something that will not have changed.
 * `code` parks on the user's browser sandbox: the code streams there, the
 * ExecutionSession runs it, and the browser posts the outcome back — the row
 * carries the outcome once it answers, or nothing but the deadline if the
 * browser never answers (sweeper turns that into the unavailable fallback).
 */
export type ParkedCallKind = "timer" | "code";

/**
 * A tool call that ended its turn and expects to be resumed.
 *
 * In the database because the pod that resumes need not be the pod that parked,
 * and because the wake can come minutes or hours later — long after the request
 * that started the turn is gone. Everything the sweeper needs to rebuild that
 * turn's context lives here or on the conversation; nothing is held in memory.
 */
export interface ParkedCall extends Timestamps {
	_id: ObjectId;
	parkedCallId: string;
	conversationId: Conversation["_id"];
	generationId?: string;
	/** The assistant message the parked turn writes into; the resume continues it in place. */
	messageId: string;
	/** Provider-issued id of the call being parked, and the uuid of its Tool updates. */
	toolCallId: string;
	toolUuid: string;

	kind: ParkedCallKind;
	/**
	 * `resuming` is the claim: a sweeper transitions out of `waiting` atomically so
	 * two pods cannot both wake the same turn. A row left in `resuming` is one whose
	 * pod died mid-resume, which is why `attempts` is counted.
	 */
	status: "waiting" | "resuming" | "resumed" | "abandoned";
	/** When the sweeper should wake this. Indexed with `status` — that pair is the sweep. */
	resumeAt: Date;
	/** Model-authored: what it is waiting for. Display text, never markup. */
	reason: string;

	/** `kind: "code"`: the code the browser sandbox runs, and the outcome the browser posted back. */
	code?: string;
	/**
	 * Set by the answer endpoint once the browser posted the run outcome. Absent
	 * means the browser never answered — the sweeper turns that into the
	 * "execution environment unavailable" fallback the prompt teaches the model
	 * to fall back to a fence on.
	 */
	outcome?: CodeExecutionOutcome;

	/**
	 * Whose turn this is. The sweeper has no request to read an identity from, so it
	 * rebuilds one from here — which also means a resume can only ever act as the
	 * user who parked it.
	 */
	userId?: User["_id"];
	sessionId?: string;

	/**
	 * Set when the user asked not to wait out the rest of the timer. The wake
	 * itself is `resumeAt` moved to now; this records that the wait was cut
	 * short, which is what the model is told on the round it resumes into.
	 */
	wokeEarlyAt?: Date;
	/**
	 * The deadline the model actually asked for, kept when an early wake
	 * overwrites `resumeAt`. Without it the resumed round cannot tell the model
	 * how much of its wait was skipped, and a 12s gap out of a 300s wait reads
	 * as "still not ready after the wait I asked for".
	 */
	plannedResumeAt?: Date;

	/** Set when a sweeper claims the row, so two pods cannot resume the same turn. */
	takenAt?: Date;
	resumedAt?: Date;
	/** Claims that failed. A row that cannot be resumed is abandoned rather than retried forever. */
	attempts: number;
	/** Why it was abandoned, for the tool result the model reads on the next turn. */
	abandonedReason?: string;
}
