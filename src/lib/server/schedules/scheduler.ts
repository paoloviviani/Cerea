/**
 * The scheduler loop: in-process, started from `hooks/init.ts` like the other
 * sweepers, ticking every 30 seconds. Kind-agnostic — it claims due rows and
 * hands each occurrence to the executor for its kind (`executors.ts`).
 *
 * **Claiming.** `claimDue` finds the earliest due, enabled row and takes it
 * with one `findOneAndUpdate` whose filter pins `nextRunAt` to the value it
 * read and the lease to free, and whose update **advances `nextRunAt` to the
 * next occurrence after now** and sets the lease. Two instances racing for the
 * same row both read the same `nextRunAt`; only one's filter still matches.
 * Because `nextRunAt` moves *before* anything runs, a crash mid-run cannot fire
 * the occurrence again; the lease (two minutes) only stops a manual run or a
 * stray second instance from starting on top of one in flight.
 *
 * **Downtime.** A claimed occurrence that is more than `ON_TIME_MS` late
 * means the process was away. It is fired as **one** catch-up only if it is
 * less than half its own interval late (capped at an hour); otherwise a
 * `missed-downtime` row is written and nothing fires. Either way the
 * occurrences in between are not replayed: `nextRunAt` already points past now.
 *
 * **Overlap and offline** are the executor's to judge (it knows what busy
 * means); the core records what it reports.
 *
 * **Failures.** Three `failed` runs in a row disable the schedule, with the
 * last reason. Any `sent` resets the count; skipped and missed runs do not move it.
 */

import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { onExit } from "$lib/server/exitHandler";
import { availableKinds, getExecutor, type ExecutorOutcome } from "./executors";
import { schedulesEnabled } from "./limits";
import { intervalAfter, nextOccurrence } from "./recurrence";
import { ScheduleError } from "./store";
import type { Schedule, ScheduleRun } from "$lib/types/Schedule";

export const TICK_MS = 30_000;
export const LEASE_MS = 2 * 60_000;
/** Later than this and a tick was missed, not merely slow. */
export const ON_TIME_MS = 2 * 60_000;
export const CATCH_UP_CAP_MS = 60 * 60_000;
export const MAX_CONSECUTIVE_FAILURES = 3;
const MAX_PER_TICK = 25;

const instanceId = new ObjectId().toHexString();

function leaseFree(now: Date) {
	return { $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] };
}

export interface Claim {
	schedule: Schedule;
	/** The occurrence claimed: the `nextRunAt` the row had before. */
	scheduledFor: Date;
}

/** Take the earliest due schedule, or null. Safe against any number of concurrent callers. */
export async function claimDue(
	now: Date,
	owner: string = instanceId,
	kinds = availableKinds()
): Promise<Claim | null> {
	if (kinds.length === 0) return null;
	const candidate = await collections.schedules
		.find({ enabled: true, kind: { $in: kinds }, nextRunAt: { $lte: now }, ...leaseFree(now) })
		.sort({ nextRunAt: 1 })
		.limit(1)
		.next();
	if (!candidate?.nextRunAt) return null;
	const next = nextOccurrence(candidate.recurrence, candidate.timezone, now, candidate.anchorAt);
	const claimed = await collections.schedules.findOneAndUpdate(
		{ _id: candidate._id, enabled: true, nextRunAt: candidate.nextRunAt, ...leaseFree(now) },
		{
			$set: { nextRunAt: next, leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: owner },
		},
		{ returnDocument: "before" }
	);
	const before = claimed?.value;
	if (!before?.nextRunAt) return null;
	return { schedule: { ...before, nextRunAt: next }, scheduledFor: before.nextRunAt };
}

export type Decision = { fire: true; detail?: string } | { fire: false; detail: string };

/** Fire on time, fire one late catch-up, or give the occurrence up. */
export function decideLateness(schedule: Schedule, scheduledFor: Date, now: Date): Decision {
	const late = now.getTime() - scheduledFor.getTime();
	if (late <= ON_TIME_MS) return { fire: true };
	const interval = intervalAfter(
		schedule.recurrence,
		schedule.timezone,
		scheduledFor,
		schedule.anchorAt
	);
	const window = Math.min(interval / 2, CATCH_UP_CAP_MS);
	const minutes = Math.round(late / 60_000);
	if (late < window) return { fire: true, detail: `Catch-up: ${minutes} min late.` };
	return {
		fire: false,
		detail: `Cerea was not running: ${minutes} min late, past the ${Math.round(window / 60_000)} min catch-up window.`,
	};
}

async function release(schedule: Schedule, owner: string): Promise<void> {
	await collections.schedules.updateOne(
		{ _id: schedule._id, leaseOwner: owner },
		{ $set: { leaseUntil: null, leaseOwner: null } }
	);
}

/** Record one occurrence and apply its outcome to the schedule. */
async function record(
	schedule: Schedule,
	scheduledFor: Date,
	trigger: ScheduleRun["trigger"],
	firedAt: Date,
	outcome: ExecutorOutcome
): Promise<ScheduleRun> {
	const run: ScheduleRun = {
		_id: new ObjectId(),
		scheduleId: schedule._id,
		userId: schedule.userId,
		kind: schedule.kind,
		scheduledFor,
		firedAt,
		status: outcome.status,
		trigger,
		...(outcome.detail ? { detail: outcome.detail.slice(0, 500) } : {}),
		...(outcome.result ? { result: outcome.result } : {}),
		scheduleName: schedule.name,
	};
	await collections.scheduleRuns.insertOne(run);

	const failures =
		outcome.status === "failed"
			? schedule.consecutiveFailures + 1
			: outcome.status === "sent"
				? 0
				: schedule.consecutiveFailures;
	const disableReason =
		outcome.disable ??
		(failures >= MAX_CONSECUTIVE_FAILURES
			? `Switched off after ${MAX_CONSECUTIVE_FAILURES} failed runs in a row. Last: ${outcome.detail ?? "failed"}`
			: null);
	const set: Partial<Schedule> = {
		lastRunAt: firedAt,
		lastStatus: outcome.status,
		consecutiveFailures: failures,
		updatedAt: new Date(),
	};
	if (disableReason) {
		set.enabled = false;
		set.nextRunAt = null;
		set.disabledReason = disableReason;
	}
	await collections.schedules.updateOne({ _id: schedule._id }, { $set: set });
	return run;
}

/** Run the executor for one claimed occurrence, never throwing. */
async function execute(
	schedule: Schedule,
	scheduledFor: Date,
	trigger: ScheduleRun["trigger"],
	now: Date
): Promise<ExecutorOutcome> {
	const executor = getExecutor(schedule.kind);
	if (!executor) return { status: "failed", detail: `Nothing here can run "${schedule.kind}".` };
	try {
		const previousRun = await collections.scheduleRuns
			.find({ scheduleId: schedule._id, status: "sent" })
			.sort({ firedAt: -1 })
			.limit(1)
			.next();
		return await executor.run({ schedule, scheduledFor, trigger, previousRun, now });
	} catch (err) {
		logger.error({ err, scheduleId: schedule._id.toString() }, "schedule_run_crashed");
		return { status: "failed", detail: err instanceof Error ? err.message : "The run crashed." };
	}
}

/** Handle one claim end to end: judge lateness, run, record, release the lease. */
export async function fireClaim(
	claim: Claim,
	now: Date,
	owner: string = instanceId
): Promise<ScheduleRun> {
	try {
		const decision = decideLateness(claim.schedule, claim.scheduledFor, now);
		if (!decision.fire) {
			return await record(claim.schedule, claim.scheduledFor, "schedule", now, {
				status: "missed-downtime",
				detail: decision.detail,
			});
		}
		const outcome = await execute(claim.schedule, claim.scheduledFor, "schedule", now);
		if (decision.detail) {
			outcome.detail = outcome.detail ? `${decision.detail} ${outcome.detail}` : decision.detail;
		}
		return await record(claim.schedule, claim.scheduledFor, "schedule", now, outcome);
	} finally {
		await release(claim.schedule, owner).catch((err) =>
			logger.warn({ err }, "schedule_lease_release_failed")
		);
	}
}

let ticking = false;

/** One pass: claim and fire everything due. Returns how many occurrences were handled. */
export async function runDue(now: Date = new Date(), owner: string = instanceId): Promise<number> {
	if (!schedulesEnabled() || ticking) return 0;
	ticking = true;
	try {
		const claims: Claim[] = [];
		while (claims.length < MAX_PER_TICK) {
			const claim = await claimDue(now, owner);
			if (!claim) break;
			claims.push(claim);
		}
		await Promise.all(
			claims.map((claim) =>
				fireClaim(claim, now, owner).catch((err) =>
					logger.error({ err, scheduleId: claim.schedule._id.toString() }, "schedule_fire_failed")
				)
			)
		);
		return claims.length;
	} finally {
		ticking = false;
	}
}

/**
 * "Run now": one immediate run of the caller's own schedule. It does not move
 * `nextRunAt` and does not wait for the lateness rules, but it takes the same
 * lease, so it cannot start on top of a run in flight, and the executor's
 * overlap rule applies exactly as for a scheduled run.
 */
export async function runNow(userId: ObjectId, id: string): Promise<ScheduleRun> {
	if (!schedulesEnabled()) throw new ScheduleError(404, "Scheduled actions are switched off.");
	let _id: ObjectId;
	try {
		_id = new ObjectId(id);
	} catch {
		throw new ScheduleError(404, "No such schedule.");
	}
	const now = new Date();
	const owner = `${instanceId}:manual`;
	const claimed = await collections.schedules.findOneAndUpdate(
		{ _id, userId, ...leaseFree(now) },
		{ $set: { leaseUntil: new Date(now.getTime() + LEASE_MS), leaseOwner: owner } },
		{ returnDocument: "after" }
	);
	if (!claimed?.value) {
		const exists = await collections.schedules.countDocuments({ _id, userId });
		throw exists
			? new ScheduleError(409, "A run of this schedule is already starting.")
			: new ScheduleError(404, "No such schedule.");
	}
	const schedule = claimed.value;
	try {
		const outcome = await execute(schedule, now, "manual", now);
		return await record(schedule, now, "manual", now, outcome);
	} finally {
		await release(schedule, owner).catch((err) =>
			logger.warn({ err }, "schedule_lease_release_failed")
		);
	}
}

export class ScheduleRunner {
	private static instance: ScheduleRunner;

	private constructor() {
		const interval = setInterval(() => {
			runDue().catch((err) => logger.error({ err }, "[schedules] tick failed"));
		}, TICK_MS);
		interval.unref?.();
		onExit(() => clearInterval(interval));
	}

	public static getInstance(): ScheduleRunner {
		if (!ScheduleRunner.instance) ScheduleRunner.instance = new ScheduleRunner();
		return ScheduleRunner.instance;
	}
}
