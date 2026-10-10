/**
 * Machine→Cerea calls (PROTOCOL.md §5): the one direction where the machine
 * asks and Cerea answers. A `call` frame carries an op, the calling session
 * (and its root) and that session's facts as galopin knows them (`caller`);
 * Cerea acts as the device's **owner** and answers `callres`. Only the
 * `schedule.*` family exists: coding agents list, create, update, pause and
 * delete the owner's scheduled actions through galopin's schedule tools.
 *
 * Every rule of the schedules store applies (15-minute floor, per-person cap,
 * timezone, the `CHAT_SCHEDULES_ENABLED` kill switch), plus the agent's own:
 *  - the target machine is always the calling one, and the workspace must be
 *    on it (the executor's `validateTarget` checks it live);
 *  - the permission mode is no looser than the caller's (deny < ask < allow)
 *    and the coordination keys are a subset of the caller's grant;
 *  - at most `MAX_ACTIVE_AGENT_SCHEDULES` running agent-created schedules per
 *    machine, and `MAX_CALLS_PER_HOUR` changes per machine per hour (a pause
 *    or a delete is counted but never refused: stopping must always work);
 *  - update and delete reach only this machine's schedules.
 * Each change is written to the /code audit trail with the calling session.
 * Whether a change needs the person's approval is galopin's decision (the
 * `schedule` permission key), made before the call is sent.
 */

import { ObjectId } from "mongodb";
import { z } from "zod";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { codeSchedulesEnabled } from "$lib/server/codeEnabled";
import { recordCodeAuditRow } from "$lib/server/code/audit";
import { MachineLink } from "$lib/server/code/machines";
import "$lib/server/code/scheduleAgentExecutor";
import type { AgentTarget } from "$lib/server/code/scheduleAgentExecutor";
import { recurrenceSchema } from "$lib/server/schedules/recurrence";
import {
	createSchedule,
	deleteSchedule,
	ScheduleError,
	updateSchedule,
} from "$lib/server/schedules/store";
import { recurrenceText } from "$lib/utils/scheduleFormat";
import { coordinationKeys } from "$lib/utils/coordination";
import {
	COORDINATION_KEYS,
	type CallErrorCode,
	type CallFrame,
	type CallResFrame,
	type CoordinationKey,
	type PermissionMode,
} from "$lib/types/machineProtocol";
import type { Schedule } from "$lib/types/Schedule";

/** The op families `welcome.features.machineCalls` advertises. */
export const MACHINE_CALL_FEATURES = ["schedule"];

export const MAX_ACTIVE_AGENT_SCHEDULES = 5;
export const MAX_CALLS_PER_HOUR = 10;
const HOUR_MS = 60 * 60 * 1000;

const MUTATING_ACTIONS = ["schedule.create", "schedule.update", "schedule.delete"];

class CallError extends Error {
	constructor(
		readonly code: CallErrorCode,
		message: string
	) {
		super(message);
	}
}

/** The opencode agent mode a run starts in: the executor's `modeId`. Not
 * bounded by the caller — the permission word bounds what a run may do. */
const AGENT_MODES = ["plan", "build"] as const;

const RANK: Record<PermissionMode, number> = { deny: 0, ask: 1, allow: 2 };
const WORD: Record<PermissionMode, string> = { deny: "Deny", ask: "Ask", allow: "Allow" };

const coordinationArg = z.array(z.enum(COORDINATION_KEYS)).max(COORDINATION_KEYS.length);

const createArgs = z.object({
	name: z.string(),
	prompt: z.string(),
	recurrence: recurrenceSchema,
	timezone: z.string().optional(),
	workspaceId: z.string().min(1).max(256).optional(),
	session: z.enum(["new", "this"]),
	permissionMode: z.enum(["deny", "ask", "allow"]),
	coordination: coordinationArg.optional(),
	agentMode: z.enum(AGENT_MODES).optional(),
	maxOccurrences: z.number().int().min(1).max(100_000).optional(),
});

const updateArgs = z.object({
	id: z.string().min(1).max(64),
	name: z.string().optional(),
	prompt: z.string().optional(),
	recurrence: recurrenceSchema.optional(),
	timezone: z.string().optional(),
	workspaceId: z.string().min(1).max(256).optional(),
	permissionMode: z.enum(["deny", "ask", "allow"]).optional(),
	coordination: coordinationArg.optional(),
	agentMode: z.enum(AGENT_MODES).optional(),
	maxOccurrences: z.number().int().min(1).max(100_000).nullish(),
	paused: z.boolean().optional(),
});

const deleteArgs = z.object({ id: z.string().min(1).max(64) });

function parseArgs<T>(schema: z.ZodType<T>, args: unknown): T {
	const parsed = schema.safeParse(args);
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const where = issue?.path.length ? ` (${issue.path.join(".")})` : "";
		throw new CallError("invalid", `The arguments are not valid${where}: ${issue?.message}.`);
	}
	return parsed.data;
}

/** The two coordination options a schedule stores, from wire keys. The
 * messaging keys come as one group, since the option grants all three. */
function optionsFromKeys(keys: CoordinationKey[]): { canMessage?: true; canSpawn?: true } {
	const messaging: CoordinationKey[] = ["session_list", "session_read", "session_send"];
	const some = messaging.filter((k) => keys.includes(k));
	if (some.length > 0 && some.length < messaging.length) {
		throw new CallError(
			"invalid",
			"Coordination comes in two groups: session_list, session_read and session_send together, " +
				"and session_spawn on its own."
		);
	}
	return {
		...(some.length ? { canMessage: true as const } : {}),
		...(keys.includes("session_spawn") ? { canSpawn: true as const } : {}),
	};
}

/** Refuse anything wider than what the calling session has itself. */
function checkWithinCaller(frame: CallFrame, target: AgentTarget): void {
	if (RANK[target.permissionMode] > RANK[frame.caller.permissionMode]) {
		throw new CallError(
			"forbidden",
			`A schedule cannot run with looser permissions than yours: you are on ${WORD[frame.caller.permissionMode]}, ` +
				`so it can be ${frame.caller.permissionMode === "ask" ? "Ask or Deny" : "Deny"} at most.`
		);
	}
	const wider = coordinationKeys(target).filter((k) => !frame.caller.coordination.includes(k));
	if (wider.length) {
		throw new CallError(
			"forbidden",
			`A schedule cannot have coordination you do not have yourself: ${wider.join(", ")}.`
		);
	}
}

interface CallContext {
	frame: CallFrame;
	deviceId: string;
	userId: ObjectId;
}

function parseTargetOf(schedule: Schedule): AgentTarget {
	return schedule.target as unknown as AgentTarget;
}

async function deviceSchedule(ctx: CallContext, id: string): Promise<Schedule> {
	let _id: ObjectId;
	try {
		_id = new ObjectId(id);
	} catch {
		throw new CallError("not_found", "There is no schedule with that id on this machine.");
	}
	const schedule = await collections.schedules.findOne({
		_id,
		userId: ctx.userId,
		kind: "agent",
		"target.deviceId": ctx.deviceId,
	});
	if (!schedule) {
		throw new CallError("not_found", "There is no schedule with that id on this machine.");
	}
	return schedule;
}

/** The schedules a run of which created or used the caller's session (or its root). */
async function schedulesRunIn(ctx: CallContext): Promise<ObjectId[]> {
	const sessions = [...new Set([ctx.frame.sessionId, ctx.frame.rootSessionId])];
	const runs = await collections.scheduleRuns
		.find({
			userId: ctx.userId,
			kind: "agent",
			"result.ids.deviceId": ctx.deviceId,
			"result.ids.sessionId": { $in: sessions },
		})
		.sort({ firedAt: -1, _id: -1 })
		.project<{ scheduleId: ObjectId }>({ scheduleId: 1 })
		.limit(50)
		.toArray();
	return runs.map((r) => r.scheduleId);
}

function listItem(schedule: Schedule, self: boolean) {
	const target = parseTargetOf(schedule);
	const by = schedule.createdBy;
	return {
		id: schedule._id.toString(),
		name: schedule.name,
		prompt: schedule.prompt,
		recurrence: schedule.recurrence,
		recurrenceText: recurrenceText(schedule.recurrence),
		timezone: schedule.timezone,
		paused: !schedule.enabled,
		status: schedule.enabled ? "active" : schedule.disabledReason ? "disabled" : "paused",
		...(schedule.disabledReason && !schedule.enabled
			? { disabledReason: schedule.disabledReason }
			: {}),
		...(schedule.lastStatus ? { lastStatus: schedule.lastStatus } : {}),
		nextRunAt: schedule.nextRunAt ? schedule.nextRunAt.toISOString() : null,
		lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
		workspace: { id: target.workspaceId, name: target.labels?.workspace ?? "" },
		session: target.sessionMode === "existing" ? (target.sessionId ?? "new") : "new",
		permissionMode: target.permissionMode,
		// No stored mode: the executor's own default for a new session.
		agentMode: target.modeId ?? "plan",
		coordination: coordinationKeys(target),
		createdBy:
			by?.kind === "agent"
				? { kind: "agent", sessionId: by.sessionId, title: by.title }
				: { kind: "person" },
		self,
	};
}

async function itemFor(ctx: CallContext, schedule: Schedule) {
	const own = await schedulesRunIn(ctx);
	return listItem(
		schedule,
		own.some((id) => id.equals(schedule._id))
	);
}

/** What a store refusal means on the wire. */
function fromScheduleError(err: ScheduleError): CallError {
	if (err.status === 404) return new CallError("not_found", err.message);
	if (err.status === 409) return new CallError("limit", err.message);
	return new CallError("invalid", err.message);
}

async function activeAgentSchedules(ctx: CallContext, except?: ObjectId): Promise<number> {
	return collections.schedules.countDocuments({
		userId: ctx.userId,
		enabled: true,
		"createdBy.kind": "agent",
		"createdBy.deviceId": ctx.deviceId,
		...(except ? { _id: { $ne: except } } : {}),
	});
}

function activeCapError(): CallError {
	return new CallError(
		"limit",
		`This machine already has ${MAX_ACTIVE_AGENT_SCHEDULES} running schedules made by agents. ` +
			"Pause or delete one first."
	);
}

async function checkRate(ctx: CallContext): Promise<void> {
	const recent = await collections.codeAudit.countDocuments({
		deviceId: new ObjectId(ctx.deviceId),
		action: { $in: MUTATING_ACTIONS },
		outcome: "ok",
		at: { $gte: new Date(Date.now() - HOUR_MS) },
	});
	if (recent >= MAX_CALLS_PER_HOUR) {
		throw new CallError(
			"limit",
			`Agents on this machine have changed schedules ${MAX_CALLS_PER_HOUR} times in the last hour. ` +
				"Try again later."
		);
	}
}

/** The owner's timezone: there is no per-person setting, so the zone of the
 * person's own most recent schedule (picked from their browser), else UTC. */
async function ownerTimezone(userId: ObjectId): Promise<string> {
	const latest = await collections.schedules.findOne(
		{ userId, $or: [{ createdBy: { $exists: false } }, { "createdBy.kind": "person" }] },
		{ sort: { createdAt: -1 }, projection: { timezone: 1 } }
	);
	return latest?.timezone ?? "UTC";
}

async function sessionTitle(ctx: CallContext): Promise<string> {
	try {
		const { session } = await new MachineLink(ctx.deviceId).sessionGet({
			sessionId: ctx.frame.sessionId,
		});
		return session.title.slice(0, 160);
	} catch {
		return "";
	}
}

async function audit(
	ctx: CallContext,
	action: string,
	outcome: string,
	schedule?: { id?: string; name?: string; workspaceId?: string }
): Promise<void> {
	await recordCodeAuditRow(ctx.userId, {
		action,
		deviceId: ctx.deviceId,
		sessionId: ctx.frame.sessionId,
		origin: "agent",
		outcome,
		...(schedule?.workspaceId ? { workspaceId: schedule.workspaceId } : {}),
		...(schedule?.id ? { scheduleId: schedule.id } : {}),
		...(schedule?.name ? { name: schedule.name.slice(0, 80) } : {}),
	});
}

async function opContext(ctx: CallContext) {
	const [latest] = await schedulesRunIn(ctx);
	return { scheduledRunOf: latest ? latest.toString() : null, enabled: codeSchedulesEnabled() };
}

async function opList(ctx: CallContext) {
	const [rows, own] = await Promise.all([
		collections.schedules
			.find({ userId: ctx.userId, kind: "agent", "target.deviceId": ctx.deviceId })
			.sort({ createdAt: 1 })
			.toArray(),
		schedulesRunIn(ctx),
	]);
	return {
		schedules: rows.map((row) =>
			listItem(
				row,
				own.some((id) => id.equals(row._id))
			)
		),
	};
}

async function opCreate(ctx: CallContext) {
	const args = parseArgs(createArgs, ctx.frame.args);
	await checkRate(ctx);
	const target: AgentTarget = {
		deviceId: ctx.deviceId,
		workspaceId: args.workspaceId ?? ctx.frame.caller.workspaceId,
		sessionMode: args.session === "this" ? "existing" : "new",
		...(args.session === "this" ? { sessionId: ctx.frame.rootSessionId } : {}),
		modeId: args.agentMode ?? "build",
		permissionMode: args.permissionMode,
		...optionsFromKeys(args.coordination ?? []),
		labels: { machine: "", workspace: "" },
	};
	if (!target.workspaceId) throw new CallError("invalid", "Say which workspace (workspaceId).");
	checkWithinCaller(ctx.frame, target);
	if ((await activeAgentSchedules(ctx)) >= MAX_ACTIVE_AGENT_SCHEDULES) throw activeCapError();

	const createdBy = {
		kind: "agent" as const,
		deviceId: ctx.deviceId,
		workspaceId: ctx.frame.caller.workspaceId || target.workspaceId,
		sessionId: ctx.frame.sessionId,
		title: await sessionTitle(ctx),
	};
	const schedule = await createSchedule(
		ctx.userId,
		{
			name: args.name,
			kind: "agent",
			prompt: args.prompt,
			recurrence: args.recurrence,
			timezone: args.timezone ?? (await ownerTimezone(ctx.userId)),
			...(args.maxOccurrences !== undefined ? { maxOccurrences: args.maxOccurrences } : {}),
			target,
		},
		{ createdBy }
	);
	// Two creates racing past the cap: the later withdraws (the store's own rule).
	if ((await activeAgentSchedules(ctx)) > MAX_ACTIVE_AGENT_SCHEDULES) {
		const earlier = await collections.schedules.countDocuments({
			userId: ctx.userId,
			enabled: true,
			"createdBy.kind": "agent",
			"createdBy.deviceId": ctx.deviceId,
			_id: { $lte: schedule._id },
		});
		if (earlier > MAX_ACTIVE_AGENT_SCHEDULES) {
			await collections.schedules.deleteOne({ _id: schedule._id });
			throw activeCapError();
		}
	}
	await audit(ctx, "schedule.create", "ok", {
		id: schedule._id.toString(),
		name: schedule.name,
		workspaceId: target.workspaceId,
	});
	return { schedule: await itemFor(ctx, schedule) };
}

async function opUpdate(ctx: CallContext) {
	const args = parseArgs(updateArgs, ctx.frame.args);
	const existing = await deviceSchedule(ctx, args.id);
	const { id, paused, ...fields } = args;
	const changes = Object.keys(fields).filter((k) => fields[k as keyof typeof fields] !== undefined);
	const stopOnly = changes.length === 0 && paused === true;
	if (!stopOnly) await checkRate(ctx);

	const before = parseTargetOf(existing);
	const targetChanged =
		args.agentMode !== undefined ||
		args.workspaceId !== undefined ||
		args.permissionMode !== undefined ||
		args.coordination !== undefined;
	let target: AgentTarget | undefined;
	if (targetChanged) {
		const keys = args.coordination ?? coordinationKeys(before);
		const rest = { ...before };
		delete rest.canMessage;
		delete rest.canSpawn;
		target = {
			...rest,
			workspaceId: args.workspaceId ?? before.workspaceId,
			...(args.agentMode ? { modeId: args.agentMode } : {}),
			permissionMode: args.permissionMode ?? before.permissionMode,
			...optionsFromKeys(keys),
		};
		if (target.workspaceId !== before.workspaceId && before.sessionMode === "existing") {
			throw new CallError(
				"invalid",
				"This schedule runs in one fixed session, so its workspace cannot change."
			);
		}
	}
	// What the schedule will do when it next runs must be within the caller:
	// a new prompt, a new target, or switching it back on all hand it over.
	// The agent mode alone is not bounded by the caller.
	const boundChanged =
		args.workspaceId !== undefined ||
		args.permissionMode !== undefined ||
		args.coordination !== undefined;
	if (args.prompt !== undefined || boundChanged || paused === false) {
		checkWithinCaller(ctx.frame, target ?? before);
	}
	if (paused === false && !existing.enabled && existing.createdBy?.kind === "agent") {
		if ((await activeAgentSchedules(ctx, existing._id)) >= MAX_ACTIVE_AGENT_SCHEDULES) {
			throw activeCapError();
		}
	}

	const updated = await updateSchedule(ctx.userId, id, {
		...(args.name !== undefined ? { name: args.name } : {}),
		...(args.prompt !== undefined ? { prompt: args.prompt } : {}),
		...(args.recurrence !== undefined ? { recurrence: args.recurrence } : {}),
		...(args.timezone !== undefined ? { timezone: args.timezone } : {}),
		...(args.maxOccurrences !== undefined ? { maxOccurrences: args.maxOccurrences } : {}),
		...(target ? { target } : {}),
		...(paused !== undefined ? { enabled: !paused } : {}),
	});
	await audit(ctx, "schedule.update", "ok", {
		id,
		name: updated.name,
		workspaceId: parseTargetOf(updated).workspaceId,
	});
	return { schedule: await itemFor(ctx, updated) };
}

async function opDelete(ctx: CallContext) {
	const args = parseArgs(deleteArgs, ctx.frame.args);
	const existing = await deviceSchedule(ctx, args.id);
	await deleteSchedule(ctx.userId, args.id);
	await audit(ctx, "schedule.delete", "ok", {
		id: args.id,
		name: existing.name,
		workspaceId: parseTargetOf(existing).workspaceId,
	});
	return {};
}

const OPS: Record<string, { mutating: boolean; run: (ctx: CallContext) => Promise<unknown> }> = {
	"schedule.context": { mutating: false, run: opContext },
	"schedule.list": { mutating: false, run: opList },
	"schedule.create": { mutating: true, run: opCreate },
	"schedule.update": { mutating: true, run: opUpdate },
	"schedule.delete": { mutating: true, run: opDelete },
};

/** One machine's changes run one at a time, so its cap and rate checks see
 * each other's writes. */
const queues = new Map<string, Promise<unknown>>();

function serialized<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
	const previous = queues.get(deviceId) ?? Promise.resolve();
	const next = previous.catch(() => undefined).then(fn);
	queues.set(deviceId, next);
	const done = () => {
		if (queues.get(deviceId) === next) queues.delete(deviceId);
	};
	next.then(done, done);
	return next;
}

/** Answer one `call` from the device `deviceId`. Never throws. */
export async function handleMachineCall(deviceId: string, frame: CallFrame): Promise<CallResFrame> {
	const fail = (code: CallErrorCode, message: string): CallResFrame => ({
		type: "callres",
		id: frame.id,
		ok: false,
		error: { code, message },
	});
	const op = OPS[frame.op];
	if (!op) return fail("unsupported", `This Cerea does not know the call "${frame.op}".`);

	let ctx: CallContext;
	try {
		const device = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
		if (!device) return fail("forbidden", "This machine is not known to Cerea.");
		if (device.status !== "paired") {
			return fail("forbidden", "This machine is not paired yet; its owner must confirm it.");
		}
		ctx = { frame, deviceId, userId: device.userId };
	} catch (err) {
		logger.warn({ err: String(err), deviceId }, "machine call: device lookup failed");
		return fail("unavailable", "Cerea could not look this machine up; try again.");
	}
	if (frame.op !== "schedule.context" && !codeSchedulesEnabled()) {
		return fail("unavailable", "Scheduled actions are switched off on this Cerea.");
	}

	try {
		const result = op.mutating ? await serialized(deviceId, () => op.run(ctx)) : await op.run(ctx);
		return { type: "callres", id: frame.id, ok: true, result };
	} catch (err) {
		const callError =
			err instanceof CallError ? err : err instanceof ScheduleError ? fromScheduleError(err) : null;
		if (!callError) {
			logger.error({ err, deviceId, op: frame.op }, "machine call failed");
			return fail("unavailable", "Cerea could not do that just now; try again.");
		}
		if (op.mutating) {
			const id = typeof frame.args.id === "string" ? frame.args.id : undefined;
			const name = typeof frame.args.name === "string" ? frame.args.name : undefined;
			await audit(ctx, `${frame.op}.refused`, callError.code, { id, name });
		}
		return fail(callError.code, callError.message);
	}
}
