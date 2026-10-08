/**
 * Schedules as a person manages them: create, read, edit, delete, history.
 * Every function is owner-scoped by `userId` — another person's id is a 404,
 * never a 403, so ids stay unguessable (the `codeDevices` rule).
 *
 * This file knows nothing about what a `target` is: it hands the input to the
 * executor for its kind (`executors.ts`) and stores what comes back.
 */

import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { getExecutor } from "./executors";
import { maxSchedulesPerUser } from "./limits";
import { isValidTimezone, nextOccurrence, validateRecurrence } from "./recurrence";
import {
	SCHEDULE_KINDS,
	type Schedule,
	type ScheduleRun,
	type ScheduleRunView,
	type ScheduleView,
} from "$lib/types/Schedule";

export class ScheduleError extends Error {
	constructor(
		readonly status: 400 | 404 | 409,
		message: string
	) {
		super(message);
		this.name = "ScheduleError";
	}
}

export const MAX_NAME_LENGTH = 80;
export const MAX_PROMPT_LENGTH = 8000;

const createSchema = z.object({
	name: z.string(),
	kind: z.enum(SCHEDULE_KINDS).default("agent"),
	target: z.unknown(),
	prompt: z.string(),
	recurrence: z.unknown(),
	timezone: z.string().default("UTC"),
	enabled: z.boolean().optional(),
});

const updateSchema = z
	.object({
		name: z.string(),
		target: z.unknown(),
		prompt: z.string(),
		recurrence: z.unknown(),
		timezone: z.string(),
		enabled: z.boolean(),
	})
	.partial();

function parseId(id: string): ObjectId {
	try {
		return new ObjectId(id);
	} catch {
		throw new ScheduleError(404, "No such schedule.");
	}
}

function checkName(raw: string): string {
	const name = raw.trim();
	if (!name) throw new ScheduleError(400, "Give the schedule a name.");
	if (name.length > MAX_NAME_LENGTH) {
		throw new ScheduleError(400, `The name can be at most ${MAX_NAME_LENGTH} characters.`);
	}
	return name;
}

function checkPrompt(raw: string): string {
	const prompt = raw.trim();
	if (!prompt) throw new ScheduleError(400, "Write the prompt the schedule sends.");
	if (prompt.length > MAX_PROMPT_LENGTH) {
		throw new ScheduleError(400, `The prompt can be at most ${MAX_PROMPT_LENGTH} characters.`);
	}
	return prompt;
}

function checkTimezone(timezone: string): string {
	if (!isValidTimezone(timezone)) throw new ScheduleError(400, "That is not a known timezone.");
	return timezone;
}

function checkRecurrence(input: unknown, timezone: string): Schedule["recurrence"] {
	const result = validateRecurrence(input, timezone);
	if (!result.ok) throw new ScheduleError(400, result.error);
	return result.recurrence;
}

async function checkTarget(
	kind: Schedule["kind"],
	target: unknown,
	userId: ObjectId
): Promise<Record<string, unknown>> {
	const executor = getExecutor(kind);
	if (!executor) throw new ScheduleError(400, `Nothing here can run "${kind}" schedules.`);
	const result = await executor.validateTarget(target, { userId });
	if (!result.ok) throw new ScheduleError(400, result.error);
	return result.target;
}

export async function createSchedule(userId: ObjectId, body: unknown): Promise<Schedule> {
	const parsed = createSchema.safeParse(body);
	if (!parsed.success) throw new ScheduleError(400, "The schedule is missing a field.");
	const input = parsed.data;
	const cap = maxSchedulesPerUser();
	if ((await collections.schedules.countDocuments({ userId })) >= cap) {
		throw new ScheduleError(409, `You can have at most ${cap} schedules. Delete one first.`);
	}
	const name = checkName(input.name);
	const prompt = checkPrompt(input.prompt);
	const timezone = checkTimezone(input.timezone);
	const recurrence = checkRecurrence(input.recurrence, timezone);
	const target = await checkTarget(input.kind, input.target, userId);

	const now = new Date();
	const enabled = input.enabled ?? true;
	const schedule: Schedule = {
		_id: new ObjectId(),
		userId,
		kind: input.kind,
		name,
		target,
		prompt,
		recurrence,
		timezone,
		anchorAt: now,
		enabled,
		nextRunAt: enabled ? nextOccurrence(recurrence, timezone, now, now) : null,
		consecutiveFailures: 0,
		createdAt: now,
		updatedAt: now,
	};
	await collections.schedules.insertOne(schedule);
	// Two creates racing past the check above would both land: settle it
	// after the fact, so the cap is a cap and not a suggestion. A row keeps its
	// place only if no more than `cap` of the person's rows are at or before
	// its id, so of any racing set the earliest ids stay and the rest withdraw.
	if ((await collections.schedules.countDocuments({ userId, _id: { $lte: schedule._id } })) > cap) {
		await collections.schedules.deleteOne({ _id: schedule._id });
		throw new ScheduleError(409, `You can have at most ${cap} schedules. Delete one first.`);
	}
	return schedule;
}

export async function getSchedule(userId: ObjectId, id: string): Promise<Schedule> {
	const schedule = await collections.schedules.findOne({ _id: parseId(id), userId });
	if (!schedule) throw new ScheduleError(404, "No such schedule.");
	return schedule;
}

export async function listSchedules(userId: ObjectId): Promise<Schedule[]> {
	return collections.schedules.find({ userId }).sort({ createdAt: 1 }).toArray();
}

export async function updateSchedule(
	userId: ObjectId,
	id: string,
	body: unknown
): Promise<Schedule> {
	const parsed = updateSchema.safeParse(body);
	if (!parsed.success) throw new ScheduleError(400, "The change is not valid.");
	const patch = parsed.data;
	const existing = await getSchedule(userId, id);
	const now = new Date();

	const set: Partial<Schedule> = { updatedAt: now };
	if (patch.name !== undefined) set.name = checkName(patch.name);
	if (patch.prompt !== undefined) set.prompt = checkPrompt(patch.prompt);
	const timezone = patch.timezone !== undefined ? checkTimezone(patch.timezone) : existing.timezone;
	if (patch.timezone !== undefined) set.timezone = timezone;
	let timetableChanged = patch.timezone !== undefined && patch.timezone !== existing.timezone;
	if (patch.recurrence !== undefined) {
		set.recurrence = checkRecurrence(patch.recurrence, timezone);
		timetableChanged = true;
	} else if (timetableChanged) {
		// A zone change can turn a valid expression into one under the floor.
		checkRecurrence(existing.recurrence, timezone);
	}
	if (patch.target !== undefined) {
		set.target = await checkTarget(existing.kind, patch.target, userId);
		set.consecutiveFailures = 0;
	}

	const enabled = patch.enabled ?? existing.enabled;
	const revived = patch.enabled === true && !existing.enabled;
	const unset: Record<string, ""> = {};
	if (patch.enabled !== undefined) set.enabled = patch.enabled;
	if (revived || patch.target !== undefined) {
		// Switching it back on, or pointing it somewhere new, is a fresh start.
		set.consecutiveFailures = 0;
		if (existing.disabledReason && enabled) unset.disabledReason = "";
	}
	if (timetableChanged) set.anchorAt = now;
	if (!enabled) set.nextRunAt = null;
	else if (timetableChanged || revived || existing.nextRunAt === null) {
		const recurrence = set.recurrence ?? existing.recurrence;
		set.nextRunAt = nextOccurrence(recurrence, timezone, now, set.anchorAt ?? existing.anchorAt);
	}

	const updated = await collections.schedules.findOneAndUpdate(
		{ _id: existing._id, userId },
		{ $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}) },
		{ returnDocument: "after" }
	);
	if (!updated?.value) throw new ScheduleError(404, "No such schedule.");
	return updated.value;
}

/** Remove the schedule. Its run rows stay: they are the record of what ran. */
export async function deleteSchedule(userId: ObjectId, id: string): Promise<void> {
	const { deletedCount } = await collections.schedules.deleteOne({ _id: parseId(id), userId });
	if (!deletedCount) throw new ScheduleError(404, "No such schedule.");
}

export async function listRuns(userId: ObjectId, id: string, limit = 50): Promise<ScheduleRun[]> {
	const scheduleId = parseId(id);
	return collections.scheduleRuns
		.find({ scheduleId, userId })
		.sort({ firedAt: -1, _id: -1 })
		.limit(Math.min(Math.max(limit, 1), 200))
		.toArray();
}

export async function scheduleView(schedule: Schedule): Promise<ScheduleView> {
	let targetLabel = "";
	try {
		targetLabel =
			(await getExecutor(schedule.kind)?.describeTarget(schedule.target, {
				userId: schedule.userId,
			})) ?? "";
	} catch {
		targetLabel = "";
	}
	return {
		id: schedule._id.toString(),
		kind: schedule.kind,
		name: schedule.name,
		target: schedule.target,
		targetLabel,
		prompt: schedule.prompt,
		recurrence: schedule.recurrence,
		timezone: schedule.timezone,
		enabled: schedule.enabled,
		...(schedule.disabledReason ? { disabledReason: schedule.disabledReason } : {}),
		nextRunAt: schedule.nextRunAt,
		...(schedule.lastRunAt ? { lastRunAt: schedule.lastRunAt } : {}),
		...(schedule.lastStatus ? { lastStatus: schedule.lastStatus } : {}),
		createdAt: schedule.createdAt,
		updatedAt: schedule.updatedAt,
	};
}

export function runView(run: ScheduleRun): ScheduleRunView {
	return {
		id: run._id.toString(),
		scheduleId: run.scheduleId.toString(),
		scheduledFor: run.scheduledFor,
		firedAt: run.firedAt,
		status: run.status,
		trigger: run.trigger,
		...(run.detail ? { detail: run.detail } : {}),
		...(run.result ? { result: run.result } : {}),
	};
}
