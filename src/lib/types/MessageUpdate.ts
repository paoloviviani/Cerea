import type { InferenceProvider } from "@huggingface/inference";
import type { ToolCall, ToolResult } from "$lib/types/Tool";
import type { PlanStep } from "$lib/types/Plan";
import type { TurnStatus } from "$lib/types/TurnState";
import type {
	ElicitationAction,
	ElicitationRequestPayload,
	ElicitationResolution,
	ElicitationValue,
} from "$lib/types/McpElicitation";
import type { RunOutcome } from "$lib/utils/execution/protocol";
import type { PersistedDeliverableRef } from "$lib/types/ParkedCall";

export type MessageUpdate =
	| MessageStatusUpdate
	| MessageTitleUpdate
	| MessageToolUpdate
	| MessageStreamUpdate
	| MessageArtifactDraftUpdate
	| MessageFileUpdate
	| MessageFinalAnswerUpdate
	| MessageReasoningUpdate
	| MessageRouterMetadataUpdate
	| MessageElicitationUpdate
	| MessagePlanUpdate
	| MessageMemoryUpdate
	| MessageBudgetUpdate
	| MessageTurnStateUpdate
	| MessageBackgroundTaskUpdate
	| MessageCodeExecutionUpdate;

export enum MessageUpdateType {
	Status = "status",
	Title = "title",
	Tool = "tool",
	Stream = "stream",
	ArtifactDraft = "artifactDraft",
	File = "file",
	FinalAnswer = "finalAnswer",
	Reasoning = "reasoning",
	RouterMetadata = "routerMetadata",
	Elicitation = "elicitation",
	Plan = "plan",
	Memory = "memory",
	Budget = "budget",
	TurnState = "turnState",
	BackgroundTask = "backgroundTask",
	CodeExecution = "codeExecution",
}

/**
 * In-band turn lifecycle transition (see TurnState). Delivered on the same
 * channel as every other update so a subscriber learns about parks, resumes
 * and endings without a side channel, and replay reproduces the history.
 * Times are epoch milliseconds; `serverNow` is stamped at emission so the
 * client can correct clock skew and render true remaining time.
 */
export interface MessageTurnStateUpdate {
	type: MessageUpdateType.TurnState;
	state: TurnStatus;
	serverNow: number;
	/** Absolute deadline, present when state === "waiting". */
	until?: number;
	reason?: string;
	error?: string;
}

// Status
export enum MessageUpdateStatus {
	Started = "started",
	Error = "error",
	Finished = "finished",
	KeepAlive = "keepAlive",
}
export interface MessageStatusUpdate {
	type: MessageUpdateType.Status;
	status: MessageUpdateStatus;
	message?: string;
	statusCode?: number;
}

// Everything else
export interface MessageTitleUpdate {
	type: MessageUpdateType.Title;
	title: string;
}
export interface MessageStreamUpdate {
	type: MessageUpdateType.Stream;
	token: string;
	/** Length of the original token. Used for compressed/persisted stream markers where token is empty. */
	len?: number;
	/** The backend part this token belongs to (the code agent's own streams):
	 * a later token of the same part keeps extending its text block even when a
	 * row (a permission card, a tool) arrived in between, so a row never splits
	 * a text part. */
	partId?: string;
}

/**
 * Live preview of an `artifact` tool call while its arguments stream in.
 * Ephemeral by design: it never touches `message.content` — the executed
 * call's canonical `<artifact>` block (a Stream update) is the only thing
 * that persists into the transcript. The panel shows the latest draft per
 * tool call as a streaming block until that canonical block replaces it; an
 * `update` draft (no content) renders as an "Editing…" placeholder, and a
 * draft with no fields yet renders as "Writing…".
 */
export interface MessageArtifactDraftUpdate {
	type: MessageUpdateType.ArtifactDraft;
	/** Provider-issued tool_call id, so newer drafts replace older ones. */
	toolCallId: string;
	command?: string;
	identifier?: string;
	artifactType?: string;
	title?: string;
	content: string;
}

// Tool updates (for MCP and function calling)
export enum MessageToolUpdateType {
	Call = "call",
	Result = "result",
	Error = "error",
	ETA = "eta",
	Progress = "progress",
}

interface MessageToolUpdateBase<TSubtype extends MessageToolUpdateType> {
	type: MessageUpdateType.Tool;
	subtype: TSubtype;
	uuid: string;
}

export interface MessageToolCallUpdate extends MessageToolUpdateBase<MessageToolUpdateType.Call> {
	call: ToolCall;
	/**
	 * Reasoning that led to this round of calls (set on the round's first call
	 * update). Lets history replay re-attach reasoning to the right assistant
	 * message; absent on messages persisted before this field existed.
	 */
	reasoning?: string;
	/**
	 * Visible text the model streamed before this round's tool calls (set on
	 * the round's first call update), e.g. "Let me check that." Lets history
	 * replay keep the preamble on its own round's assistant message instead of
	 * moving it after the tool results; absent on messages persisted before
	 * this field existed.
	 */
	content?: string;
	/**
	 * Original provider-issued tool_call id and raw JSON arguments string, as
	 * sent by the model (set on every Call update; argumentsRaw only when it
	 * validates as JSON — a malformed string is never persisted here, since
	 * replaying invalid JSON in a historical tool call could get the whole
	 * continuation rejected by providers that validate the field). Replay
	 * uses argumentsRaw when present for byte-accurate arguments instead of
	 * reserializing the sanitized primitive parameters; the emitted
	 * tool_call_id is always the
	 * normalized one regardless (see toToolCallId in prepareFiles.ts), so
	 * originalId is captured for future fidelity but not replayed as-is.
	 * Absent on messages persisted before this field existed, or if the
	 * provider's response omitted an id.
	 */
	originalId?: string;
	argumentsRaw?: string;
}

export interface MessageToolResultUpdate extends MessageToolUpdateBase<MessageToolUpdateType.Result> {
	result: ToolResult;
}

export interface MessageToolErrorUpdate extends MessageToolUpdateBase<MessageToolUpdateType.Error> {
	message: string;
}

export interface MessageToolEtaUpdate extends MessageToolUpdateBase<MessageToolUpdateType.ETA> {
	eta: number;
}

export interface MessageToolProgressUpdate extends MessageToolUpdateBase<MessageToolUpdateType.Progress> {
	progress: number;
	total?: number;
	message?: string;
}

export type MessageToolUpdate =
	| MessageToolCallUpdate
	| MessageToolResultUpdate
	| MessageToolErrorUpdate
	| MessageToolEtaUpdate
	| MessageToolProgressUpdate;

export enum MessageReasoningUpdateType {
	Stream = "stream",
	Status = "status",
}

export type MessageReasoningUpdate = MessageReasoningStreamUpdate | MessageReasoningStatusUpdate;

export interface MessageReasoningStreamUpdate {
	type: MessageUpdateType.Reasoning;
	subtype: MessageReasoningUpdateType.Stream;
	token: string;
}
export interface MessageReasoningStatusUpdate {
	type: MessageUpdateType.Reasoning;
	subtype: MessageReasoningUpdateType.Status;
	status: string;
}

export interface MessageFileUpdate {
	type: MessageUpdateType.File;
	name: string;
	sha: string;
	mime: string;
}
export interface MessageFinalAnswerUpdate {
	type: MessageUpdateType.FinalAnswer;
	text: string;
	interrupted: boolean;
}
export interface MessageRouterMetadataUpdate {
	type: MessageUpdateType.RouterMetadata;
	route: string;
	model: string;
	provider?: InferenceProvider;
}

export enum MessageElicitationUpdateType {
	Request = "request",
	Resolved = "resolved",
}

export enum MessageCodeExecutionUpdateType {
	Request = "request",
	Resolved = "resolved",
	/**
	 * Files a code block or an artifact cell produced, persisted like a tool
	 * run's (see `MessageCodeExecutionOutputsUpdate`).
	 */
	Outputs = "outputs",
}

export interface MessageCodeExecutionRequestUpdate {
	type: MessageUpdateType.CodeExecution;
	subtype: MessageCodeExecutionUpdateType.Request;
	/** uuid of the parked call row the browser answers against. */
	executionId: string;
	/** The code the browser's ExecutionSession runs. */
	code: string;
	/** Epoch ms of the sweeper's backstop deadline; shown like a 2026-era prompt (no countdown). */
	expiresAt?: number;
}

/**
 * The run outcome the browser posted back, persisted for replay. `outcome`
 * never carries file bytes or sandbox paths: the worker filesystem dies with
 * the page load, so a path replayed from here would be a dead reference — the
 * live run's own files still show through the session-only RunsStore →
 * RunOutput → FileCard path while the tab holds them.
 *
 * `files`, when present, is the durable side: deliverables the browser
 * uploaded to the server-side output store (30-day TTL, per-user, access
 * controlled like a message attachment — see
 * `$lib/server/execution/deliverables.ts`). A download card on replay, on
 * reload, or from another device renders from these references, addressed by
 * conversation + sha256, never from `outcome`.
 */
export interface MessageCodeExecutionResolvedUpdate {
	type: MessageUpdateType.CodeExecution;
	subtype: MessageCodeExecutionUpdateType.Resolved;
	executionId: string;
	outcome: RunOutcome;
	files?: PersistedDeliverableRef[];
}

/**
 * The persisted output files of a run the browser started on its own — an
 * auto-running or manually run chat code block, or an artifact cell — as
 * opposed to an `execute_code` tool run, whose files ride on its `Resolved`
 * update. One record per settled run, appended to the assistant message the
 * code belongs to, so every produced file is retained and shown the same way
 * however it was produced: same store, same caps and TTL, same file artifact.
 */
export interface MessageCodeExecutionOutputsUpdate {
	type: MessageUpdateType.CodeExecution;
	subtype: MessageCodeExecutionUpdateType.Outputs;
	/** The run's key (`chatRunKey` / `artifactRunKey`), so a replayed block finds its own files. */
	runKey: string;
	files: PersistedDeliverableRef[];
}

export type MessageCodeExecutionUpdate =
	| MessageCodeExecutionRequestUpdate
	| MessageCodeExecutionResolvedUpdate
	| MessageCodeExecutionOutputsUpdate;

export type MessageElicitationUpdate =
	MessageElicitationRequestUpdate | MessageElicitationResolvedUpdate;

export interface MessageElicitationRequestUpdate {
	type: MessageUpdateType.Elicitation;
	subtype: MessageElicitationUpdateType.Request;
	request: ElicitationRequestPayload;
	/**
	 * Epoch ms. Only a 2025-era prompt has one — it blocks a live request. A 2026-era
	 * prompt is answered out of band and never expires, so the UI shows no countdown.
	 */
	expiresAt?: number;
	/** Only set when exactly one call was in flight; MCP does not link the two. */
	toolUuid?: string;
}

/** Always emitted, even when nobody answered, so replay never shows a form still waiting. */
export interface MessageElicitationResolvedUpdate {
	type: MessageUpdateType.Elicitation;
	subtype: MessageElicitationUpdateType.Resolved;
	elicitationId: string;
	action: ElicitationAction;
	resolution: ElicitationResolution;
	/** What was submitted, so a reloaded transcript can still show the answers. */
	content?: Record<string, ElicitationValue>;
}

/**
 * Snapshot of the plan after an `update_plan` call. Plain JSON only (no Date):
 * it travels the JSONL stream and is persisted verbatim in `Message.updates`.
 * The authoritative current state lives on `Conversation.plan`.
 */
export interface MessagePlanUpdate {
	type: MessageUpdateType.Plan;
	/** uuid of the update_plan tool call that produced this state. */
	uuid: string;
	goal: string;
	steps: PlanStep[];
	/** Model-authored one-line changelog for this update. */
	explanation?: string;
	version: number;
}

/**
 * A `remember` or `forget` call that changed what is stored about the person.
 *
 * Emitted so the write is **visible where it happened**. Memory is the one
 * tool here that edits something outside the conversation and outlives it,
 * and it is deliberately not behind the approval gate (ADR 0075) — a card
 * asking permission for every fact would train people to click through, and
 * the call has no external reach and costs nothing. Showing the write
 * afterwards, with a way to undo it, is the safeguard instead of asking
 * first.
 *
 * `memoryId` is what makes the undo possible: it is the row to delete for a
 * `remembered`. A `forgot` carries no id — the row is gone — so undoing one
 * re-creates the fact from `text`, which is why the text is carried in full
 * rather than referenced.
 *
 * Plain JSON only (no Date): it travels the JSONL stream and is persisted
 * verbatim in `Message.updates`.
 */
export interface MessageMemoryUpdate {
	type: MessageUpdateType.Memory;
	/** uuid of the remember/forget tool call that produced this. */
	uuid: string;
	action: "remembered" | "forgot";
	/** The fact, as stored or as removed. */
	text: string;
	/** The stored row, present only for `remembered`. */
	memoryId?: string;
	/**
	 * Present when the write was to a project's shared notes
	 * (`remember_for_project` / `forget_for_project`) rather than the person's
	 * own: names the list so the card's undo calls the project's route.
	 */
	scope?: "project";
	projectId?: string;
}

/**
 * Snapshot of the ML Assistant compute budget after a reservation, release or
 * settle. Display-only: the authoritative state lives on `Conversation.mlBudget`
 * and every transition is a guarded write there. Amounts in integer micro-USD.
 */
export interface MessageBudgetUpdate {
	type: MessageUpdateType.Budget;
	totalMicroUsd: number;
	spentMicroUsd: number;
	/** Sum of open reservation ceilings — held, not yet settled. */
	reservedMicroUsd: number;
}

/**
 * A background subagent's lifecycle marker (opencode 1.18.32 task
 * background:true, behind OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS).
 *
 * The task tool returns immediately with state "running" while the child
 * keeps working after its parent turn ends; opencode later injects a
 * synthetic `<task>` message with state "completed" or "error" carrying the
 * result. Both fold here — never as model text — so the parent shows one
 * visible marker per background child: running, then completed or failed.
 *
 * `taskId` is the child session id (the `<task id>` / tool metadata); `callId`
 * is the parent's task tool call that spawned it, when known (a synthetic
 * result names only the child, so it carries no call). `followUp` means the
 * call resumed that child with `task_id` rather than spawning it; `automatic`
 * means the frame came from opencode's own synthetic injection rather than a
 * model-authored tool result. Plain JSON only: it travels the agent SSE
 * bridge and is persisted verbatim in `Message.updates`.
 */
export interface MessageBackgroundTaskUpdate {
	type: MessageUpdateType.BackgroundTask;
	/** The child session id. */
	taskId: string;
	/** The parent's task tool call, when the frame is anchored on one. */
	callId?: string;
	state: "running" | "completed" | "error";
	/** The `<summary>` line opencode composed ("Background task started…"). */
	summary?: string;
	/** The result text (completed/error), or the guidance text (running). */
	text?: string;
	/** The call carried `task_id`: a follow-up to this child, not a spawn. */
	followUp?: boolean;
	/** From opencode's synthetic injection, not from a tool result. */
	automatic?: boolean;
}
