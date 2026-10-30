/**
 * The executor registry: the one seam between the scheduler core and
 * whatever a schedule actually does.
 *
 * **The contract.** An executor is a plain object, registered once at boot
 * with `registerExecutor`:
 *
 * ```ts
 * registerExecutor({
 *   kind: "agent",                                  // a `ScheduleKind`
 *   available?: () => boolean,                      // false: the core leaves its rows alone
 *   validateTarget(target, { userId }),             // -> { ok: true, target } | { ok: false, error }
 *   describeTarget(target, { userId }),             // -> the short label a list shows
 *   run({ schedule, scheduledFor, trigger, previousRun, now }),  // -> an `ExecutorOutcome`
 * });
 * ```
 *
 * - `validateTarget` is the only thing that ever reads a person's `target`
 *   input. It checks it against what the **caller owns** (the core cannot:
 *   it does not know what a target is), and returns the normalised target
 *   that is stored. Called on create and on every edit that touches it.
 * - `describeTarget` turns a stored target into text. It must be cheap and
 *   must not throw; it runs once per row of a list.
 * - `run` does the work for one occurrence and **returns** what happened; it
 *   throws only for a bug (the core records that as `failed`). The outcome's
 *   `status` is one of the run statuses: `sent`, `skipped-still-running`
 *   (the executor found the previous run's output still busy — the core
 *   passes `previousRun`, the last `sent` row, with its result link),
 *   `missed-offline`, `failed`. `disable` switches the schedule off with that
 *   reason (a revoked machine). The core alone counts consecutive failures
 *   and disables at three; and alone decides downtime catch-up, leases and
 *   `nextRunAt`.
 * - `result` is the link the history shows from the run (agent: the session).
 *
 * **Credentials (optional).** A kind whose runs have no signed-in session
 * (chat: a turn must reach the gateway as the person) sets three more hooks.
 * `mintCredential` runs with the person's session on create, on re-enable
 * when the schedule holds none, and when `credentialStale` says an edit
 * changed what the credential was for; the core stores what it returns
 * (never sends it to a browser) and hands it back in `run` as
 * `schedule.credential`. `releaseCredential` runs when the schedule is
 * deleted or its credential is replaced, best-effort: a failure is logged,
 * never blocks the delete. Turning a schedule off keeps its credential. A run
 * that finds the credential dead returns `dropCredential` with `disable`, and
 * the core forgets it, so the next re-enable mints a fresh one.
 *
 * The core never imports an executor. A new kind is **one new file that calls
 * `registerExecutor` plus its import in `hooks/init.ts`**: a "chat" runner
 * needs nothing else (`ScheduleKind` already reserves the word).
 */

import type {
	Schedule,
	ScheduleCredential,
	ScheduleKind,
	ScheduleRun,
	ScheduleRunResult,
	ScheduleRunStatus,
} from "$lib/types/Schedule";
import type { ObjectId } from "mongodb";

export interface ExecutorCaller {
	userId: ObjectId;
	/** The caller's own session token, when this call has one (an API request does, a scheduler tick does not). */
	token?: string;
}

export type TargetCheck =
	{ ok: true; target: Record<string, unknown> } | { ok: false; error: string };

export interface ExecutorRunContext {
	schedule: Schedule;
	/** The occurrence this run stands for. */
	scheduledFor: Date;
	trigger: "schedule" | "manual";
	/** The last run of this schedule that was `sent`, with its result link. */
	previousRun: ScheduleRun | null;
	now: Date;
}

/** A credential hook's refusal, in words the person reads (the store maps it onto an HTTP status). */
export class CredentialError extends Error {
	constructor(
		readonly status: 400 | 403 | 502,
		message: string
	) {
		super(message);
		this.name = "CredentialError";
	}
}

export interface CredentialRequest {
	userId: ObjectId;
	/** The schedule's name, for the key's label. */
	name: string;
	target: Record<string, unknown>;
	/** The person's own session token; absent when the caller has no session. */
	token?: string;
}

export interface ExecutorOutcome {
	status: ScheduleRunStatus;
	detail?: string;
	result?: ScheduleRunResult;
	/** Switch the schedule off, with a reason the person will read. */
	disable?: string;
	/** The schedule's credential no longer works: forget it (with `disable`). */
	dropCredential?: boolean;
	/**
	 * For a run that returned before its work ended: settles with what happened at the
	 * end. Only a failure matters, and the core then corrects the run row, feeds the
	 * consecutive-failure count and applies `disable` / `dropCredential`; undefined is fine.
	 */
	settled?: Promise<
		Pick<ExecutorOutcome, "status" | "detail" | "disable" | "dropCredential"> | undefined
	>;
}

export interface ScheduleExecutor {
	kind: ScheduleKind;
	available?: () => boolean;
	validateTarget(target: unknown, caller: ExecutorCaller): Promise<TargetCheck>;
	describeTarget(target: Record<string, unknown>, caller: ExecutorCaller): Promise<string>;
	run(context: ExecutorRunContext): Promise<ExecutorOutcome>;
	mintCredential?(request: CredentialRequest): Promise<ScheduleCredential | undefined>;
	/** Whether editing the target from `before` to `after` needs a new credential. */
	credentialStale?(before: Record<string, unknown>, after: Record<string, unknown>): boolean;
	releaseCredential?(schedule: Schedule, caller: { token?: string }): Promise<void>;
	/** Housekeeping the scheduler calls every few minutes (renew keys, retry revocations). Never throws into the loop. */
	maintain?(now: Date): Promise<void>;
}

const executors = new Map<ScheduleKind, ScheduleExecutor>();

export function registerExecutor(executor: ScheduleExecutor): void {
	executors.set(executor.kind, executor);
}

/** The executor for a kind, or null: an unknown kind is refused, never guessed. */
export function getExecutor(kind: string): ScheduleExecutor | null {
	return executors.get(kind as ScheduleKind) ?? null;
}

export function registeredExecutors(): ScheduleExecutor[] {
	return [...executors.values()];
}

/** The kinds the scheduler may fire right now. */
export function availableKinds(): ScheduleKind[] {
	return [...executors.values()].filter((e) => !e.available || e.available()).map((e) => e.kind);
}

/** For tests: forget every registration. */
export function _clearExecutors(): void {
	executors.clear();
}
