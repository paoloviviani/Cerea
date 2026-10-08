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
 * The core never imports an executor. A new kind is **one new file that calls
 * `registerExecutor` plus its import in `hooks/init.ts`**: a "chat" runner
 * needs nothing else (`ScheduleKind` already reserves the word).
 */

import type {
	Schedule,
	ScheduleKind,
	ScheduleRun,
	ScheduleRunResult,
	ScheduleRunStatus,
} from "$lib/types/Schedule";
import type { ObjectId } from "mongodb";

export interface ExecutorCaller {
	userId: ObjectId;
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

export interface ExecutorOutcome {
	status: ScheduleRunStatus;
	detail?: string;
	result?: ScheduleRunResult;
	/** Switch the schedule off, with a reason the person will read. */
	disable?: string;
}

export interface ScheduleExecutor {
	kind: ScheduleKind;
	available?: () => boolean;
	validateTarget(target: unknown, caller: ExecutorCaller): Promise<TargetCheck>;
	describeTarget(target: Record<string, unknown>, caller: ExecutorCaller): Promise<string>;
	run(context: ExecutorRunContext): Promise<ExecutorOutcome>;
}

const executors = new Map<ScheduleKind, ScheduleExecutor>();

export function registerExecutor(executor: ScheduleExecutor): void {
	executors.set(executor.kind, executor);
}

/** The executor for a kind, or null: an unknown kind is refused, never guessed. */
export function getExecutor(kind: string): ScheduleExecutor | null {
	return executors.get(kind as ScheduleKind) ?? null;
}

/** The kinds the scheduler may fire right now. */
export function availableKinds(): ScheduleKind[] {
	return [...executors.values()].filter((e) => !e.available || e.available()).map((e) => e.kind);
}

/** For tests: forget every registration. */
export function _clearExecutors(): void {
	executors.clear();
}
