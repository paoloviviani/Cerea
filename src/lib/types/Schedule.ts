import type { ObjectId } from "mongodb";
import type { Timestamps } from "./Timestamps";
import type { User } from "./User";

/**
 * Scheduled actions: something Cerea does for a person on a timetable.
 *
 * The record is **kind-agnostic**. `kind` names the executor that knows what a
 * run means (`server/schedules/executors.ts`), and `target` is that
 * executor's own business — the core never looks inside it. Only `"agent"`
 * exists today: a prompt sent to a coding session on one of the person's
 * paired machines. `"chat"` posts the prompt into a conversation (or a new one
 * each time) and runs a server-side turn (`schedules/chatScheduleExecutor.ts`).
 *
 * **Owner-only.** A row belongs to `userId` (the /code panel has no anonymous
 * sessions, like `codeDevices`), is erased with the account and moved on a
 * merge (`identity/userKeyedCollections.ts`).
 */

export const SCHEDULE_KINDS = ["agent", "chat"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

/** What a person picks. `hours` is "every N hours", anchored on `anchorAt`;
 * the rest are wall-clock in the schedule's timezone, DST-correct. */
export type Recurrence =
	| { type: "hours"; every: number }
	| { type: "daily"; at: string }
	| { type: "weekdays"; at: string }
	| { type: "weekly"; day: number; at: string }
	| { type: "cron"; expr: string };

export type ScheduleRunStatus =
	"sent" | "skipped-still-running" | "missed-offline" | "missed-downtime" | "failed";

export const SCHEDULE_RUN_STATUSES: ScheduleRunStatus[] = [
	"sent",
	"skipped-still-running",
	"missed-offline",
	"missed-downtime",
	"failed",
];

/** Who made a schedule. Absent on a row = a person (every row before agents
 * could). An agent's schedule names the coding session that created it, so
 * the list can link back to it. */
export type ScheduleCreator =
	| { kind: "person" }
	| {
			/** The chat assistant proposed it and the person confirmed on the approval card. */
			kind: "chat";
			conversationId: string;
			/** The conversation's title when it made the schedule. */
			title: string;
	  }
	| {
			kind: "agent";
			deviceId: string;
			workspaceId: string;
			sessionId: string;
			/** The session's title when it made the schedule. */
			title: string;
	  };

export interface Schedule extends Timestamps {
	_id: ObjectId;
	userId: User["_id"];
	kind: ScheduleKind;
	name: string;
	/** Kind-specific and opaque to the core; shaped and checked by the executor. */
	target: Record<string, unknown>;
	prompt: string;
	recurrence: Recurrence;
	/** IANA zone the recurrence is read in. */
	timezone: string;
	/** The instant "every N hours" counts from. */
	anchorAt: Date;
	enabled: boolean;
	/** Why the core or an executor switched it off (never set by the person). */
	disabledReason?: string;
	/** Null once the schedule is disabled. */
	nextRunAt: Date | null;
	lastRunAt?: Date;
	lastStatus?: ScheduleRunStatus;
	/** Consecutive `failed` runs; three disable the schedule. */
	consecutiveFailures: number;
	/** Stop after this many scheduled fires; absent = run for ever. */
	maxOccurrences?: number;
	/** How many scheduled fires have happened; absent on old rows reads as 0. */
	firedCount: number;
	/** The claim: while in the future another instance leaves the schedule alone. */
	leaseUntil?: Date | null;
	leaseOwner?: string | null;
	createdBy?: ScheduleCreator;
}

/** The result link of a run: where the executor put its output. */
export interface ScheduleRunResult {
	/** What `kind` it points into, e.g. "agent-session" or "chat" (ids: conversationId). */
	type: string;
	/** Executor-defined ids (agent: deviceId, workspaceId, sessionId). */
	ids: Record<string, string>;
	label?: string;
}

/** One row per occurrence considered, fired or not: the audit record. */
export interface ScheduleRun {
	_id: ObjectId;
	scheduleId: ObjectId;
	userId: User["_id"];
	kind: ScheduleKind;
	/** The occurrence this run stands for (the instant it was due). */
	scheduledFor: Date;
	firedAt: Date;
	status: ScheduleRunStatus;
	trigger: "schedule" | "manual";
	detail?: string;
	result?: ScheduleRunResult;
	/** A snapshot of the schedule's name at the time (it can be renamed or deleted later). */
	scheduleName: string;
}

/** What the API sends the browser. */
export interface ScheduleView {
	id: string;
	kind: ScheduleKind;
	name: string;
	target: Record<string, unknown>;
	/** "machine › workspace › (new session | session title)", from the executor. */
	targetLabel: string;
	prompt: string;
	recurrence: Recurrence;
	timezone: string;
	enabled: boolean;
	disabledReason?: string;
	nextRunAt: Date | null;
	lastRunAt?: Date;
	lastStatus?: ScheduleRunStatus;
	/** The optional stopping criterion, and how far it has got. */
	maxOccurrences?: number;
	firedCount: number;
	/** Only for a schedule an assistant created; a person's has none. */
	createdBy?: Exclude<ScheduleCreator, { kind: "person" }>;
	createdAt: Date;
	updatedAt: Date;
}

export interface ScheduleRunView {
	id: string;
	scheduleId: string;
	scheduledFor: Date;
	firedAt: Date;
	status: ScheduleRunStatus;
	trigger: "schedule" | "manual";
	detail?: string;
	result?: ScheduleRunResult;
}

/**
 * A person's background grant: the OIDC refresh token every login writes (the newest replaces the
 * older), which browser sessions and scheduled chat runs both refresh through (`schedules/grants.ts`),
 * so a rotation by one can never leave another holding a stale copy. One per person, sealed.
 */
export interface ScheduleGrant {
	_id: ObjectId;
	userId: User["_id"];
	/** The refresh token, sealed (`secretBox.ts`). */
	refreshSealed: string;
	/** The last access token it produced, sealed, kept until shortly before it ends. */
	accessSealed?: string;
	accessExpiresAt?: Date;
	/** What the IdP says was granted. */
	scope?: string;
	/** The IdP's subject the login authenticated, and when that login happened (the newest login's token is the one kept). */
	sub?: string;
	issuedAt: Date;
	createdAt: Date;
	updatedAt: Date;
}
