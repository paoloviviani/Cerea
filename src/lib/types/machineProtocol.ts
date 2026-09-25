/**
 * The thin machine agent wire protocol (v1) — the one contract this file, the
 * Go agent (`galopin`, in this repository's `agent/`) and `reports/2026-09-24-thin-agent-protocol.md`
 * all implement. Source of truth is the report; this module is its TypeScript
 * half.
 *
 * JSON text frames over one WebSocket, `type` discriminates. Unknown frame
 * types and unknown event kinds are ignored by both sides (forward
 * compatibility); unknown ops answer `unsupported`. Everything here is plain
 * JSON — times are RFC 3339 strings, never Dates.
 */

import { z } from "zod";

// -- backend/policy, reported once in `hello` --------------------------------

export interface Backend {
	id: string;
	version: string;
	capabilities: {
		diff: boolean;
		children: boolean;
		usage: boolean;
		compact: boolean;
		images: boolean;
		files: boolean;
		worktrees: boolean;
		autoAccept: boolean;
		/** The user-question tool design: a native multiple-choice question
		 * mechanism (opencode: its built-in "question" tool). ACP reports
		 * false — it has no wire message for this. */
		questions: boolean;
	};
}

export interface Policy {
	autoAccept: "allowed" | "denied";
	workspaceRoots: string[];
	allowFreeModels: boolean;
}

export type CredentialState = "ok" | "expiring" | "expired";

// -- domain types (§6 result shapes) -----------------------------------------

export interface Workspace {
	id: string;
	name: string;
	path: string;
	createdAt: string;
	isGitRepo: boolean;
	worktreeOf?: string;
	branch?: string;
}

/** One `workspace.suggest` result: a directory autocomplete candidate. */
export interface Directory {
	path: string;
	name: string;
	isGitRepo: boolean;
}

export type SessionStatus = "idle" | "busy" | "retry" | "error";

export interface Usage {
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextUsed: number;
	contextMax: number | null;
}

export interface Session {
	id: string;
	workspaceId: string;
	backend: string;
	title: string;
	status: SessionStatus;
	pendingPermissions: number;
	modeId: string | null;
	modelId: string | null;
	autoAccept: boolean;
	parentId: string | null;
	/** For a child session (session.children): the parent's tool call that spawned it. */
	parentToolCallId?: string;
	/** The top-level ancestor (the session itself when it has no parent). */
	rootId?: string;
	/** A parent's subagents: direct children, those mid-turn, and descendants
	 * waiting on a permission reply. Absent when it spawned none. */
	childSummary?: { children: number; running: number; waiting: number };
	createdAt: string;
	updatedAt: string;
	usage: Usage | null;
}

export interface Mode {
	id: string;
	label: string;
	description?: string;
}

export interface Model {
	id: string;
	label: string;
	providerId: string;
	isDefault?: boolean;
	contextWindow?: number;
	images?: boolean;
	reasoning?: boolean;
}

export interface Attachment {
	type: "file";
	mime: string;
	filename: string;
	/** A data: URL for P0; later a Cerea attachment-store URL. */
	url: string;
}

export interface FileDiff {
	path: string;
	status: "added" | "modified" | "deleted";
	before: string;
	after: string;
	additions: number;
	deletions: number;
}

export interface Todo {
	id: string;
	content: string;
	status: "pending" | "in_progress" | "completed" | "cancelled";
	priority?: string;
}

export interface Message {
	id: string;
	role: "user" | "assistant";
	parentId?: string;
	createdAt: string;
	modeId?: string;
	modelId?: string;
	completedAt?: string;
	error?: string;
	/** Echoed back on the user message the machine creates from a
	 * `session.prompt` call — always present on a message this deployment
	 * originated, since `session.prompt` always carries one (minted
	 * server-side when the browser's request omits it). The key later
	 * attachments (images/files) key off, once the attachment store lands. */
	clientMessageId?: string;
}

export type Part =
	| ({ id: string; messageId: string; role: string; type: "text" } & {
			text: string;
			synthetic?: boolean;
	  })
	| ({ id: string; messageId: string; role: string; type: "reasoning" } & { text: string })
	| ({ id: string; messageId: string; role: string; type: "tool" } & {
			callId: string;
			tool: string;
			status: "pending" | "running" | "completed" | "error";
			title?: string;
			input: Record<string, unknown>;
			output?: string;
			error?: string;
	  })
	| ({ id: string; messageId: string; role: string; type: "file" } & {
			mime: string;
			filename?: string;
			url?: string;
	  })
	| ({ id: string; messageId: string; role: string; type: "subtask" } & {
			sessionId?: string;
			description?: string;
			agent?: string;
	  })
	| ({ id: string; messageId: string; role: string; type: "compaction" } & { auto: boolean });

/** One choice offered for a Question (opencode's own QuestionOption). */
export interface QuestionOption {
	label: string;
	description?: string;
}

/** One question of a (possibly multi-question) ask — opencode's own
 * built-in "question" tool, verified live against 1.18.31. */
export interface Question {
	question: string;
	header?: string;
	options: QuestionOption[];
	multiple?: boolean;
	/** opencode's own flag, on unless false: its tool description tells the
	 * model a "Type your own answer" choice is added automatically. */
	custom?: boolean;
}

export interface PermissionRequest {
	id: string;
	sessionId: string;
	tool: string;
	title: string;
	patterns: string[];
	metadata: Record<string, unknown>;
	callId?: string;
	messageId?: string;
	always: string[];
}

export interface Transcript {
	messages: Array<{ message: Message; parts: Part[] }>;
	permissions: PermissionRequest[];
	status: SessionStatus;
	usage: Usage | null;
	todos: Todo[];
}

// -- normalized events (§7) --------------------------------------------------

export type NormalizedEvent =
	| { kind: "message"; message: Message }
	| { kind: "part"; part: Part }
	| { kind: "delta"; messageId: string; partId: string; role: string; field: "text"; delta: string }
	| { kind: "part.removed"; messageId: string; partId: string }
	| { kind: "status"; status: SessionStatus; detail?: string }
	| { kind: "permission.asked"; request: PermissionRequest }
	| { kind: "permission.replied"; requestId: string; decision: string; by: "user" | "auto" }
	| { kind: "usage"; usage: Usage }
	| { kind: "session"; session: Session }
	| { kind: "error"; message: string; code?: string }
	| { kind: "todo"; todos: Todo[] }
	| { kind: "question.asked"; request: { id: string; questions: Question[]; callId?: string } }
	| { kind: "question.resolved"; requestId: string; answers?: string[][]; rejected?: true };

export interface Envelope {
	sessionId: string;
	epoch: string;
	seq: number;
	/** The top-level ancestor of `sessionId` (itself for a top-level
	 * session) — what lets a root's watchers receive a subagent's
	 * envelopes mid-turn. Absent from machines that predate the field;
	 * those fall back to matching `sessionId` (see `machines.ts`). */
	rootSessionId?: string;
	event: NormalizedEvent;
}

// -- operations (§6) ----------------------------------------------------------

/** Every op name a Cerea→machine `req` frame may carry. */
export type OpName =
	| "workspace.list"
	| "workspace.suggest"
	| "workspace.create"
	| "workspace.rename"
	| "workspace.archive"
	| "session.list"
	| "session.get"
	| "session.create"
	| "session.prompt"
	| "session.cancel"
	| "session.rename"
	| "session.archive"
	| "session.delete"
	| "session.setMode"
	| "session.setModel"
	| "session.setAutoAccept"
	| "permission.reply"
	| "question.reply"
	| "session.sync"
	| "session.diff"
	| "session.children"
	| "session.compact"
	| "backend.modes"
	| "backend.models";

export type ErrorCode =
	"not_found" | "invalid" | "forbidden" | "unavailable" | "backend" | "unsupported";

export class OpError extends Error {
	constructor(
		readonly code: ErrorCode,
		message: string
	) {
		super(message);
		this.name = "OpError";
	}
}

/** Per-op default deadlines (§3): 15s, except `session.sync` at 20s. */
export function opDeadlineMs(op: OpName): number {
	return op === "session.sync" ? 20_000 : 15_000;
}

export type SyncResult =
	| { epoch: string; seq: number; events: Envelope[] }
	| { epoch: string; seq: number; snapshot: Transcript };

// -- frames -------------------------------------------------------------------

/** M→C, the first frame on every connection. */
export interface HelloFrame {
	type: "hello";
	protocol: number;
	agent: { version: string; os: string; arch: string; hostname: string };
	backends: Backend[];
	policy: Policy;
	credential: { state: CredentialState };
}

/** C→M, answering `hello`. */
export interface WelcomeFrame {
	type: "welcome";
	deviceId: string;
	status: "pending" | "paired";
}

/** C→M, sent once the browser confirms a pending machine. */
export interface StatusFrame {
	type: "status";
	status: "paired";
}

/** C→M, one outstanding operation. */
export interface ReqFrame {
	type: "req";
	id: string;
	op: OpName;
	args: unknown;
}

/** M→C, answering a `req` by id. */
export type ResFrame =
	| { type: "res"; id: string; ok: true; result: unknown }
	| { type: "res"; id: string; ok: false; error: { code: ErrorCode; message: string } };

/** M→C, pushed for every session of the machine. */
export interface EventFrame {
	type: "event";
	sessionId: string;
	epoch: string;
	seq: number;
	/** The top-level ancestor of `sessionId` (itself for a top-level
	 * session). Optional for forward compatibility: older machines omit
	 * it and Cerea falls back to `sessionId`. */
	rootSessionId?: string;
	event: NormalizedEvent;
}

/** M→C, the gateway/enrollment credential's health. */
export interface CredentialFrame {
	type: "credential";
	state: CredentialState;
	detail?: string;
}

/** M→C, token renewal. */
export interface AuthFrame {
	type: "auth";
	token: string;
}

export type MachineToCereaFrame = HelloFrame | ResFrame | EventFrame | CredentialFrame | AuthFrame;

// -- zod parsing for frames arriving from the machine ------------------------
//
// The machine is authenticated (§3) but its frames are still untrusted input
// off a socket; a malformed frame is dropped or closes the connection with
// 4000, never a thrown 500 deep in a handler.

const backendSchema = z.object({
	id: z.string(),
	version: z.string(),
	capabilities: z.object({
		diff: z.boolean(),
		children: z.boolean(),
		usage: z.boolean(),
		compact: z.boolean(),
		images: z.boolean(),
		files: z.boolean(),
		worktrees: z.boolean(),
		autoAccept: z.boolean(),
		questions: z.boolean(),
	}),
});

const policySchema = z.object({
	autoAccept: z.enum(["allowed", "denied"]),
	workspaceRoots: z.array(z.string()),
	allowFreeModels: z.boolean(),
});

export const helloFrameSchema: z.ZodType<HelloFrame> = z.object({
	type: z.literal("hello"),
	protocol: z.number(),
	agent: z.object({
		version: z.string(),
		os: z.string(),
		arch: z.string(),
		hostname: z.string(),
	}),
	backends: z.array(backendSchema),
	policy: policySchema,
	credential: z.object({ state: z.enum(["ok", "expiring", "expired"]) }),
});

// Not annotated `z.ZodType<ResFrame>`: zod infers an object's `unknown`-typed
// field as optional (it accepts `undefined`), which the strict `ResFrame`
// union (`result: unknown`, always present) then rejects on assignment.
// `parseMachineFrame` below casts through the runtime check instead.
export const resFrameSchema = z.union([
	z.object({ type: z.literal("res"), id: z.string(), ok: z.literal(true), result: z.unknown() }),
	z.object({
		type: z.literal("res"),
		id: z.string(),
		ok: z.literal(false),
		error: z.object({
			code: z.enum(["not_found", "invalid", "forbidden", "unavailable", "backend", "unsupported"]),
			message: z.string(),
		}),
	}),
]);

const normalizedEventSchema: z.ZodType<NormalizedEvent> = z.any();

export const eventFrameSchema: z.ZodType<EventFrame> = z.object({
	type: z.literal("event"),
	sessionId: z.string(),
	epoch: z.string(),
	seq: z.number(),
	event: normalizedEventSchema,
});

export const credentialFrameSchema: z.ZodType<CredentialFrame> = z.object({
	type: z.literal("credential"),
	state: z.enum(["ok", "expiring", "expired"]),
	detail: z.string().optional(),
});

export const authFrameSchema: z.ZodType<AuthFrame> = z.object({
	type: z.literal("auth"),
	token: z.string(),
});

/** Parse one machine→Cerea frame; `null` for anything unrecognized (dropped,
 * never thrown — forward compatibility per the spec). */
export function parseMachineFrame(raw: unknown): MachineToCereaFrame | null {
	if (typeof raw !== "object" || raw === null || !("type" in raw)) return null;
	switch ((raw as { type: unknown }).type) {
		case "hello":
			return helloFrameSchema.safeParse(raw).success ? (raw as unknown as HelloFrame) : null;
		case "res":
			return resFrameSchema.safeParse(raw).success ? (raw as unknown as ResFrame) : null;
		case "event":
			return eventFrameSchema.safeParse(raw).success ? (raw as unknown as EventFrame) : null;
		case "credential":
			return credentialFrameSchema.safeParse(raw).success
				? (raw as unknown as CredentialFrame)
				: null;
		case "auth":
			return authFrameSchema.safeParse(raw).success ? (raw as unknown as AuthFrame) : null;
		default:
			return null;
	}
}

/** WS subprotocol and endpoint path from the spec's §3. */
export const MACHINE_PROTOCOL = "pystino-machine.v1";
export const MACHINE_PATH = "/api/v2/code/machine";
