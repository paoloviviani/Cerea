/**
 * The one place the machine's normalized shapes become the panel's frames.
 *
 * The wire vocabulary (`$lib/types/machineProtocol.ts`) tells a part's role
 * directly (`Part.role`), so no status inference is needed to tell a
 * user echo from an assistant token — the mapping here is a pure function of
 * one part or event at a time. The one place that still needs a sliver of
 * caller-held state is turn-level failure: `status: "idle"` means "done"
 * unless the turn's last assistant message carries an `error`, and a live
 * `status` event does not itself repeat that message — callers (the SSE
 * bridge) track the one string and pass it in, per spec §8's "keep
 * per-connection state only where needed".
 *
 * `snapshotToUpdates` folds a whole `Transcript` (a `session.sync` snapshot,
 * or an offline read); `eventToUpdates` folds one live `NormalizedEvent`.
 * Both route through the same part/permission/todo mapping so a snapshot and
 * its later live tail render identically.
 */

import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageBackgroundTaskUpdate,
	type MessageElicitationRequestUpdate,
	type MessageElicitationResolvedUpdate,
	type MessagePlanUpdate,
	type MessageToolCallUpdate,
	type MessageToolErrorUpdate,
	type MessageToolResultUpdate,
	type MessageTurnStateUpdate,
} from "$lib/types/MessageUpdate";
import type {
	AgentCompactionUpdate,
	AgentMessageBoundaryUpdate,
	AgentStreamUpdate,
	AgentUsageUpdate,
} from "$lib/types/CodeAgent";
import { ToolResultStatus, type ToolResult } from "$lib/types/Tool";
import type {
	Envelope,
	NormalizedEvent,
	Part,
	PermissionRequest,
	Question,
	RetryInfo,
	SessionStatus,
	Todo,
	ToolAttachment,
	Transcript,
	Usage,
} from "$lib/types/machineProtocol";
import { usableAttachments, type ToolImageUrl } from "./toolImages";
import type { ElicitationValue } from "$lib/types/McpElicitation";
import { permissionToElicitation, questionToElicitation } from "$lib/utils/codeInboxCards";

/**
 * The plan revision counter, per session. A module-wide counter was shared
 * by every session of every person on the process — one person's plan
 * updates moved another's `version`, and the uuid leaked the traffic. Kept
 * for the last few hundred sessions only: it is a re-key hint for a card,
 * not a record.
 */
const PLAN_VERSIONS_KEPT = 500;
const planVersions = new Map<string, number>();
function nextPlanVersion(sessionId: string): number {
	const version = (planVersions.get(sessionId) ?? 0) + 1;
	planVersions.delete(sessionId);
	planVersions.set(sessionId, version);
	if (planVersions.size > PLAN_VERSIONS_KEPT) {
		const oldest = planVersions.keys().next().value;
		if (oldest !== undefined) planVersions.delete(oldest);
	}
	return version;
}

/**
 * A subagent's envelope, as the parent's bridge sees it: which child asked,
 * and the title the approval/question card labels it with (from the session
 * list or a `session` event — null while unknown).
 */
export interface ChildContext {
	childId: string;
	childTitle?: string | null;
}

function toolCallUpdate(
	callId: string,
	tool: string,
	input: Record<string, unknown>
): MessageToolCallUpdate {
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Call,
		uuid: callId,
		call: { name: tool, parameters: (input ?? {}) as Record<string, string | number | boolean> },
	};
}

function toolResultUpdate(
	callId: string,
	tool: string,
	input: Record<string, unknown>,
	output: string | undefined,
	attachments: ToolAttachment[] = [],
	imageUrl?: ToolImageUrl,
	omitted = 0
): MessageToolResultUpdate {
	const outputs: Record<string, unknown>[] = output ? [{ text: output }] : [];
	// Images ride as URLs into the forwarder's attachment route, never as
	// bytes (PROTOCOL.md §7): a snapshot and the live stream share this map.
	const images = imageUrl ? usableAttachments(attachments) : [];
	if (imageUrl && images.length) {
		outputs.push({
			// `size` lets the strip hold a large image back until it is asked for.
			content: images.map((a) => ({
				type: "image",
				mimeType: a.mime,
				url: imageUrl(a.sha256),
				size: a.size,
			})),
		});
	}
	// Say so when images were left out, whether the machine dropped them
	// (`attachmentsOmitted`) or this side did (an entry it will not put in a url).
	const notShown = imageUrl
		? Math.max(0, omitted) + (Array.isArray(attachments) ? attachments.length - images.length : 0)
		: 0;
	if (notShown > 0) {
		outputs.push({
			text: `${notShown} ${notShown === 1 ? "image" : "images"} not shown (too many, too large or not a supported type).`,
			// The same count, structured, for the collapsed card's "+N" chip.
			imagesNotShown: notShown,
		});
	}
	const result: ToolResult = {
		status: ToolResultStatus.Success,
		call: { name: tool, parameters: (input ?? {}) as Record<string, string | number | boolean> },
		outputs,
		display: true,
	};
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Result,
		uuid: callId,
		result,
	};
}

function toolErrorUpdate(callId: string, message: string): MessageToolErrorUpdate {
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Error,
		uuid: callId,
		message,
	};
}

/** The machine's `Usage` (spec §6) → Cerea's own side-channel shape. The
 * mapping lives here, in one place, so an upstream field rename is a
 * one-line fix rather than a hunt through every caller. */
function usageToUpdate(usage: Usage): AgentUsageUpdate {
	return {
		type: "usage",
		usage: {
			used: usage.contextUsed,
			...(usage.contextMax != null ? { max: usage.contextMax } : {}),
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			reasoning: usage.reasoning,
		},
	};
}

/**
 * opencode's background-task envelope (1.18.32 task tool, behind
 * OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS): `<task id state>` with a
 * `<summary>` and a `<task_result>`/`<task_error>` body. The task tool's
 * immediate output carries it (state "running" while the child keeps
 * working), and the finished child's result is injected back as a synthetic
 * text part carrying it (state "completed" or "error"). Null when the text
 * is not that shape — model prose quoting the tags must never become a
 * marker.
 */
export interface BackgroundTaskXml {
	id: string;
	state: "running" | "completed" | "error";
	summary?: string;
	text?: string;
}

export function parseBackgroundTaskXml(text: string | undefined): BackgroundTaskXml | null {
	if (!text) return null;
	const open = text.match(/<task\s+id="([^"]+)"\s+state="([^"]+)">/);
	if (!open) return null;
	const state = open[2];
	if (state !== "running" && state !== "completed" && state !== "error") return null;
	const body = text.slice(
		open[0].length,
		text.lastIndexOf("</task>") >= 0 ? text.lastIndexOf("</task>") : undefined
	);
	const summary = body.match(/<summary>([\s\S]*?)<\/summary>/)?.[1]?.trim() || undefined;
	const result =
		body.match(/<task_result>([\s\S]*?)<\/task_result>/)?.[1] ??
		body.match(/<task_error>([\s\S]*?)<\/task_error>/)?.[1];
	return {
		id: open[1],
		state,
		...(summary ? { summary } : {}),
		...(result !== undefined ? { text: result.trim() || undefined } : {}),
	};
}

/** Whether a task tool call's input resumes a running child (`task_id`)
 * rather than spawning one — the honest "follow-up" label, not a new spawn. */
function isTaskFollowUp(input: Record<string, unknown> | undefined): boolean {
	if (!input) return false;
	for (const key of ["task_id", "taskId"]) {
		const value = input[key];
		if (typeof value === "string" && value.trim()) return true;
	}
	return false;
}

function backgroundTaskUpdate(
	taskId: string,
	state: MessageBackgroundTaskUpdate["state"],
	options?: {
		callId?: string;
		summary?: string;
		text?: string;
		followUp?: boolean;
		automatic?: boolean;
	}
): MessageBackgroundTaskUpdate {
	return {
		type: MessageUpdateType.BackgroundTask,
		taskId,
		...(options?.callId ? { callId: options.callId } : {}),
		state,
		...(options?.summary ? { summary: options.summary } : {}),
		...(options?.text ? { text: options.text } : {}),
		...(options?.followUp ? { followUp: true } : {}),
		...(options?.automatic ? { automatic: true } : {}),
	};
}

/**
 * How an agent's thinking reaches the panel: the chat's own wire shape.
 *
 * The chat folds a model's reasoning into the answer stream wrapped in
 * `<think>…</think>` (`runMcpFlow` does it for provider `reasoning` deltas),
 * and `ChatMessage` already splits that into a collapsible "Thinking" block
 * beside the answer text — collapsed once the turn is over, stripped from the
 * copy button. The agent view renders through the same component, so
 * reasoning parts take the same route instead of a second representation.
 *
 * Live, a `delta` names only its part, so the part's type — told by the
 * `part` event that announced it — has to be remembered between events:
 * `ThinkingState` is that memory, one per watched session, kept by the SSE
 * bridge. The wire has no "reasoning part finished" signal, so the block is
 * closed lazily, by the next frame that is not more reasoning (an answer
 * token, a tool call, a turn state, the next message).
 */
const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

export interface ThinkingState {
	/** Part id → what its text is, learned from `part` events. */
	kinds: Map<string, "text" | "reasoning">;
	/** Deltas that arrived before their part's event, by part id: held until
	 * the part announces its type, because guessing "answer" is what glued
	 * the thinking onto the answer. Released as answer text if the turn (or
	 * the message) ends first, so a part the machine never announced loses
	 * nothing. */
	held: Map<string, string>;
	/** The part whose `<think>` block is open on the client, if any. */
	openPart: string | null;
	/** The last todo list this stream sent, per session (content, status,
	 * priority): opencode re-publishes `todo.updated` with an unchanged list,
	 * and a repeat must not make a new card. Per stream, never per server:
	 * every connection maps the same events, and a shared memory would let
	 * the first viewer's stream swallow the change for every other viewer. */
	todos?: Map<string, string>;
}

export function newThinkingState(): ThinkingState {
	return { kinds: new Map(), held: new Map(), openPart: null, todos: new Map() };
}

const streamToken = (token: string, partId?: string): AgentStreamUpdate => ({
	type: MessageUpdateType.Stream,
	token,
	...(partId ? { partId } : {}),
});

/** Text of a part of a known kind → frames, opening or closing the thinking
 * block as the kind demands. */
function routeText(
	state: ThinkingState,
	partId: string,
	kind: "text" | "reasoning",
	text: string
): AgentStreamUpdate[] {
	if (!text) return [];
	if (kind === "reasoning") {
		if (state.openPart === null) {
			state.openPart = partId;
			return [streamToken(THINK_OPEN + text)];
		}
		// A second reasoning part with no answer or tool between: one block.
		const gap = state.openPart === partId ? "" : "\n\n";
		state.openPart = partId;
		return [streamToken(gap + text)];
	}
	return [...closeThinking(state), streamToken(text, partId)];
}

function closeThinking(state: ThinkingState): AgentStreamUpdate[] {
	if (state.openPart === null) return [];
	state.openPart = null;
	return [streamToken(THINK_CLOSE)];
}

/** Held deltas given up on: they become answer text, in arrival order. */
function releaseHeld(state: ThinkingState): AgentStreamUpdate[] {
	const out: AgentStreamUpdate[] = [];
	for (const [partId, text] of state.held) out.push(...routeText(state, partId, "text", text));
	state.held.clear();
	return out;
}

/** Frames that are not part of the transcript's own flow: they never end a
 * thinking block that is still open. */
const isSideChannel = (update: AgentStreamUpdate) =>
	update.type === "usage" || update.type === "childActivity" || update.type === "compaction";

/** What the thinking state does with one live event's frames: a part event
 * learns the part's type (and releases what waited on it); a delta is routed
 * by it; anything else that produces frames closes an open thinking block. */
function applyThinking(
	state: ThinkingState,
	event: NormalizedEvent,
	frames: () => AgentStreamUpdate[]
): AgentStreamUpdate[] {
	// The model's own text and thinking; a user echo or a backend-injected
	// part keeps its own mapping and, like any other frame, ends the thinking.
	if (
		event.kind === "part" &&
		event.part.role !== "user" &&
		((event.part.type === "text" && !event.part.synthetic) || event.part.type === "reasoning")
	) {
		const part = event.part;
		const kind = part.type === "reasoning" ? "reasoning" : "text";
		// The text contract (PROTOCOL.md §7): a part's first event carries its
		// text so far and growth after that arrives as deltas, so a part already
		// seen adds nothing here.
		const known = state.kinds.has(part.id);
		state.kinds.set(part.id, kind);
		const out = routeText(state, part.id, kind, known ? "" : part.text);
		const waiting = state.held.get(part.id);
		if (waiting !== undefined) {
			state.held.delete(part.id);
			out.push(...routeText(state, part.id, kind, waiting));
		}
		return out;
	}
	if (event.kind === "delta") {
		if (event.field !== "text") return [];
		const kind = state.kinds.get(event.partId);
		if (kind) return routeText(state, event.partId, kind, event.delta);
		state.held.set(event.partId, (state.held.get(event.partId) ?? "") + event.delta);
		return [];
	}
	const out = frames();
	if (out.every(isSideChannel)) return out;
	// The turn moved on (a tool, a boundary, a status): thinking is over, and
	// what never found its part is the answer after all.
	return [...closeThinking(state), ...releaseHeld(state), ...out];
}

/** One part → zero or more panel frames. A part upserts in place on the
 * wire (spec §7's text contract); folded here as its current, whole value —
 * a snapshot read and a live `part` event both call this the same way.
 * `clientMessageId` (the owning message's, when it is a user message) rides
 * onto the `user` frame — the key attachments will use once the attachment
 * store lands; the fold ignores it for now. So does the message's `command`
 * marker (PROTOCOL.md §7): the bubble renders "/name args" and folds the
 * expanded text beneath it. */
function partToUpdates(
	part: Part,
	clientMessageId?: string,
	command?: { name: string; arguments: string },
	imageUrl?: ToolImageUrl
): AgentStreamUpdate[] {
	switch (part.type) {
		case "text": {
			// Synthetic parts are backend-injected, never model text — except
			// the background-task result injection, which is the completion
			// half of a visible parent marker (parsed strictly, never shown
			// as prose). Anything else synthetic stays dropped.
			if (part.synthetic) {
				const parsed = parseBackgroundTaskXml(part.text);
				if (!parsed) return [];
				return [
					backgroundTaskUpdate(parsed.id, parsed.state, {
						summary: parsed.summary,
						text: parsed.text,
						automatic: true,
					}),
				];
			}
			if (!part.text) return [];
			return part.role === "user"
				? [
						{
							type: "user",
							text: part.text,
							...(clientMessageId ? { messageId: clientMessageId } : {}),
							...(command ? { command } : {}),
						},
					]
				: [{ type: MessageUpdateType.Stream, token: part.text, partId: part.id }];
		}
		case "tool": {
			const call = toolCallUpdate(part.callId, part.tool, part.input);
			if (part.status === "pending" || part.status === "running") return [call];
			if (part.status === "error")
				return [call, toolErrorUpdate(part.callId, part.error ?? "The call failed.")];
			const frames: AgentStreamUpdate[] = [
				call,
				toolResultUpdate(
					part.callId,
					part.tool,
					part.input,
					part.output,
					part.attachments,
					imageUrl,
					part.attachmentsOmitted
				),
			];
			// A background task's immediate output is the running half of
			// the same marker: the child keeps working after this turn ends.
			// Foreground tasks complete inline (state "completed" with no
			// background ask) and keep their existing tool rendering alone —
			// a marker there would double the subagent card.
			if (part.tool === "task") {
				const parsed = parseBackgroundTaskXml(part.output);
				const askedBackground = part.input?.["background"] === true;
				if (parsed && (parsed.state === "running" || askedBackground)) {
					frames.push(
						backgroundTaskUpdate(parsed.id, parsed.state, {
							callId: part.callId,
							summary: parsed.summary,
							text: parsed.text,
							followUp: isTaskFollowUp(part.input),
						})
					);
				}
			}
			return frames;
		}
		case "compaction": {
			const update: AgentCompactionUpdate = { type: "compaction", auto: part.auto };
			return [update];
		}
		// A reload finds the whole part: its thinking, closed, in the chat's
		// own `<think>` wrapping (see `ThinkingState`).
		case "reasoning":
			return part.text ? [streamToken(THINK_OPEN + part.text + THINK_CLOSE)] : [];
		// file/subtask: the diff pane and the polled subagent roster are the
		// panel's surfaces for those, not the transcript fold.
		default:
			return [];
	}
}

export function permissionRequestToUpdate(
	request: PermissionRequest,
	child?: ChildContext
): MessageElicitationRequestUpdate {
	// The card payload lives in `$lib/utils/codeInboxCards` (shared with the
	// Needs-you inbox) — this stays a thin wrap so the stream and the inbox
	// can never drift apart.
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request: permissionToElicitation(request, child),
	};
}

export function permissionResolvedToUpdate(
	requestId: string,
	decision: string
): MessageElicitationResolvedUpdate {
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Resolved,
		elicitationId: requestId,
		action: decision === "reject" ? "decline" : "accept",
		resolution: "user",
	};
}

/** `question.asked` → the same elicitation mechanism, reusing chat's own
 * `ask_user_question` shape (the user-question tool design): each machine
 * `Question` normalizes to one `select` field — `AskQuestion.svelte` (the
 * card `source: "assistant"` already lifts to the composer for) walks
 * `fields` as a multi-step flow exactly as it does for chat's own tool.
 * `value` is the option's own label, not an index: opencode's reply body
 * wants the chosen labels back verbatim, and this is what
 * `AskQuestion.svelte`'s own submit already collects into `content[name]`.
 *
 * The card payload lives in `$lib/utils/codeInboxCards` (shared with the
 * Needs-you inbox) — this stays a thin wrap so the stream and the inbox
 * can never drift apart. */
export function questionRequestedToUpdate(
	event: {
		requestId: string;
		questions: Question[];
	},
	child?: ChildContext
): MessageElicitationRequestUpdate {
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request: questionToElicitation(event.requestId, event.questions, child),
	};
}

/** `question.resolved` closes that card. `answers` is carried into `content`
 * keyed the same way questionRequestedToUpdate named its fields (`q0`,
 * `q1`, …), so a reloaded transcript still shows what was chosen — the
 * same purpose `content` already serves for chat's own `ask_user_question`. */
export function questionResolvedToUpdate(event: {
	requestId: string;
	answers?: string[][];
	rejected?: true;
}): MessageElicitationResolvedUpdate {
	const content: Record<string, ElicitationValue> = {};
	event.answers?.forEach((answer, i) => (content[`q${i}`] = answer));
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Resolved,
		elicitationId: event.requestId,
		action: event.rejected ? "decline" : "accept",
		resolution: "user",
		...(event.answers ? { content } : {}),
	};
}

function todoKey(todos: Todo[]): string {
	return JSON.stringify(todos.map((t) => [t.content, t.status, t.priority ?? ""]));
}
/** Records `todos` as the last list this stream sent for the session and
 * says whether it repeats the previous one. Without a stream's state there
 * is nothing to compare against: every list is new. */
function rememberTodos(
	state: ThinkingState | undefined,
	sessionId: string,
	todos: Todo[]
): boolean {
	if (!state) return false;
	state.todos ??= new Map();
	const key = todoKey(todos);
	const same = state.todos.get(sessionId) === key;
	state.todos.set(sessionId, key);
	return same;
}

function todoToUpdate(todos: Todo[], sessionId = ""): MessagePlanUpdate {
	const version = nextPlanVersion(sessionId);
	return {
		type: MessageUpdateType.Plan,
		uuid: `agent-plan-${sessionId}`,
		goal: todos[0]?.content ?? "",
		version,
		steps: todos.map((todo) => ({
			step: todo.content,
			// `cancelled` is the agent dropping the item, not one still to do:
			// `skipped` is the vocabulary the card renders struck through.
			status:
				todo.status === "completed"
					? "completed"
					: todo.status === "in_progress"
						? "in_progress"
						: todo.status === "cancelled"
							? "skipped"
							: "pending",
			...(todo.priority ? { priority: todo.priority } : {}),
		})),
	};
}

function turnStateUpdate(
	state: MessageTurnStateUpdate["state"],
	reason?: string,
	retry?: RetryInfo
): MessageTurnStateUpdate {
	return {
		type: MessageUpdateType.TurnState,
		state,
		serverNow: Date.now(),
		...(reason ? { reason } : {}),
		...(retry ? { retry } : {}),
	};
}

/** The HTTP statuses an error event's `code` may carry (PROTOCOL.md §7) — an
 * ACP backend's JSON-RPC code is negative, a command failure has none, and
 * neither is a provider's answer. */
function isHttpStatus(code: string | undefined): boolean {
	if (!code) return false;
	const status = Number(code);
	return Number.isInteger(status) && status >= 400 && status <= 599;
}

/** A provider refusal's one-line fix, for the statuses that mean the account
 * or the key, not the request. */
const PROVIDER_CREDIT_HINT = " Check the provider's credit or key, or switch model.";

/** The reason a failed turn shows on itself (PROTOCOL.md §7): the provider's
 * own text, framed for a person, plus the one fix worth trying when the
 * provider answered with an auth/payment status. The stored error and the
 * error event are the model/provider's failures by construction, so both get
 * the framing; an empty message (an older galopin) stays empty, which is
 * today's look. */
export function providerRefusalReason(
	message: string | undefined,
	code?: string
): string | undefined {
	if (!message) return undefined;
	const hint = code === "401" || code === "402" || code === "403" ? PROVIDER_CREDIT_HINT : "";
	return `The model's provider refused the request: ${message}${hint}`;
}

/** One live `error` event's reason. A code that reads as an HTTP status marks
 * a provider refusal; anything else (a command that would not run, an ACP
 * failure) already says what happened and shows as it is. */
function errorEventReason(message: string | undefined, code?: string): string | undefined {
	if (!message) return undefined;
	if (isHttpStatus(code)) return providerRefusalReason(message, code);
	return message;
}

/** The reason a provider-refusal `error` event leaves in the caller's tracked
 * `lastAssistantError`, so the `idle` that follows the error event ends the
 * turn on the same framed text the event itself emitted (undefined: nothing
 * to upgrade — other failures stay with whatever the transcript carries). */
export function trackedErrorReason(event: { message: string; code?: string }): string | undefined {
	if (!isHttpStatus(event.code) || !event.message) return undefined;
	return providerRefusalReason(event.message, event.code);
}

/** `status` → turn state (spec §8): `busy`/`retry` are running, `idle` is
 * done unless the turn's last assistant message carries an error — that one
 * bit of context the caller supplies, since a bare `status` event does not
 * repeat it. */
function statusToTurnState(
	status: SessionStatus,
	lastAssistantError: string | undefined,
	detail?: string,
	retry?: RetryInfo
): MessageTurnStateUpdate {
	switch (status) {
		case "busy":
			return turnStateUpdate("running", detail);
		case "retry":
			// Still a running turn, but one waiting on the provider: the retry
			// facts ride along so the view can say so (an older galopin sends none).
			return turnStateUpdate("running", detail, retry);
		case "error":
			return turnStateUpdate("failed", detail ?? lastAssistantError);
		default:
			return turnStateUpdate(lastAssistantError ? "failed" : "done", lastAssistantError);
	}
}

/** One live normalized event → zero or more panel frames. `lastAssistantError`
 * is the bridge's own tiny bit of tracked state (spec §8), consulted only for
 * a `status: "idle"` event. `resolveClientMessageId` is the same idea for a
 * user part's owning message — a `part` event carries only `messageId`, not
 * the message's `clientMessageId`, so the caller (which has already seen the
 * `message` event that named it) supplies the lookup.
 *
 * `child` marks an envelope that belongs to a subagent of the watched
 * session rather than the session itself: its approvals and questions
 * become the same labelled cards the parent renders (carrying the child's
 * session id, so the reply routes to the child's request), while
 * everything else — tokens, tool calls, turn states — stays out of the
 * parent's transcript and surfaces only as a `childActivity` side-channel
 * cue for the subagent card to re-sync on.
 *
 * `thinking` is the per-session memory `delta` routing needs (see
 * `ThinkingState`): the caller keeps one for the connection's lifetime. */
export function eventToUpdates(
	event: NormalizedEvent,
	lastAssistantError?: string,
	resolveClientMessageId?: (messageId: string) => string | undefined,
	child?: ChildContext,
	resolveCommand?: (messageId: string) => { name: string; arguments: string } | undefined,
	imageUrl?: ToolImageUrl,
	sessionId?: string,
	thinking: ThinkingState = newThinkingState()
): AgentStreamUpdate[] {
	if (child) {
		switch (event.kind) {
			case "permission.asked":
				return [permissionRequestToUpdate(event.request, child)];
			case "permission.replied":
				return [permissionResolvedToUpdate(event.requestId, event.decision)];
			case "question.asked":
				return [
					questionRequestedToUpdate(
						{
							requestId: event.request.id,
							questions: event.request.questions,
						},
						child
					),
				];
			case "question.resolved":
				return [
					questionResolvedToUpdate({
						requestId: event.requestId,
						answers: event.answers,
						rejected: event.rejected,
					}),
				];
			default:
				return [{ type: "childActivity", childId: child.childId }];
		}
	}
	return applyThinking(thinking, event, () =>
		liveFrames(
			event,
			lastAssistantError,
			resolveClientMessageId,
			resolveCommand,
			imageUrl,
			sessionId,
			thinking
		)
	);
}

/** The watched session's own event → frames, before thinking is routed.
 * `stream` is the connection's own state (here: the last todo list sent). */
function liveFrames(
	event: NormalizedEvent,
	lastAssistantError: string | undefined,
	resolveClientMessageId: ((messageId: string) => string | undefined) | undefined,
	resolveCommand:
		((messageId: string) => { name: string; arguments: string } | undefined) | undefined,
	imageUrl: ToolImageUrl | undefined,
	sessionId: string | undefined,
	stream: ThinkingState
): AgentStreamUpdate[] {
	switch (event.kind) {
		case "message": {
			// A pure boundary marker (see `AgentMessageBoundaryUpdate`): the
			// message's own text/tool content still arrives as `part` events on
			// the same message, this only names it.
			const boundary: AgentMessageBoundaryUpdate = {
				type: "messageBoundary",
				role: event.message.role,
				messageId: event.message.id,
				...(event.message.role === "user" && event.message.sentBy
					? { sentBy: event.message.sentBy }
					: {}),
			};
			return [boundary];
		}
		case "part":
			return partToUpdates(
				event.part,
				event.part.role === "user" ? resolveClientMessageId?.(event.part.messageId) : undefined,
				event.part.role === "user" ? resolveCommand?.(event.part.messageId) : undefined,
				imageUrl
			);
		case "delta":
			return []; // routed by part type in `applyThinking`, never here
		case "part.removed":
			return [];
		case "status":
			return [statusToTurnState(event.status, lastAssistantError, event.detail, event.retry)];
		case "permission.asked":
			return [permissionRequestToUpdate(event.request)];
		case "permission.replied":
			return [permissionResolvedToUpdate(event.requestId, event.decision)];
		case "usage":
			return [usageToUpdate(event.usage)];
		case "session":
			return []; // metadata changed; the panel re-reads via its own poll.
		case "error":
			return [turnStateUpdate("failed", errorEventReason(event.message, event.code))];
		case "todo":
			// An unchanged list is not an update: no new card, no new version.
			return rememberTodos(stream, sessionId ?? "", event.todos)
				? []
				: [todoToUpdate(event.todos, sessionId)];
		case "question.asked":
			return [
				questionRequestedToUpdate({
					requestId: event.request.id,
					questions: event.request.questions,
				}),
			];
		case "question.resolved":
			return [
				questionResolvedToUpdate({
					requestId: event.requestId,
					answers: event.answers,
					rejected: event.rejected,
				}),
			];
		default:
			return [];
	}
}

/** opencode's own `question` tool result reads
 * `User has answered your questions: "<q1>"="<a, b>", "<q2>"="<c>". You can now…`,
 * answers joined with ", " and "Unanswered" for none. Split back into per-question
 * label lists, using the options to re-split a multi-pick (a label may itself hold
 * ", "); whatever is left over is the text the user typed. Null when the text is
 * not that shape, so a changed upstream wording degrades to no summary. */
export function answersFromQuestionOutput(
	questions: Question[],
	output: string | undefined
): string[][] | null {
	if (!output || questions.length === 0) return null;
	const answers: string[][] = [];
	let cursor = 0;
	for (let i = 0; i < questions.length; i++) {
		const opener = `"${questions[i].question}"="`;
		const start = output.indexOf(opener, cursor);
		if (start < 0) return null;
		const from = start + opener.length;
		const next = questions[i + 1];
		const end = next
			? output.indexOf(`", "${next.question}"="`, from)
			: output.lastIndexOf(`". You can now`);
		if (end < from) return null;
		const joined = output.slice(from, end);
		cursor = end;
		if (joined === "Unanswered") {
			answers.push([]);
			continue;
		}
		if (!questions[i].multiple) {
			answers.push([joined]);
			continue;
		}
		const labels = new Set(questions[i].options.map((o) => o.label));
		const picked: string[] = [];
		let pending: string[] = [];
		for (const piece of joined.split(", ")) {
			pending.push(piece);
			const candidate = pending.join(", ");
			if (labels.has(candidate)) {
				picked.push(candidate);
				pending = [];
			}
		}
		if (pending.length) picked.push(pending.join(", "));
		answers.push(picked);
	}
	return answers;
}

/** A completed `question` tool part, as a reload finds it: the live card came
 * from `question.asked`/`question.resolved`, which a snapshot does not replay,
 * so rebuild the answered card from the call's own input and result. Keyed by
 * the call id — the live card's opencode request id is not on the part — which
 * cannot collide with a live card because a snapshot only precedes live events
 * that come after the question was already answered. */
function answeredQuestionFromPart(part: Part): AgentStreamUpdate[] {
	if (part.type !== "tool" || part.tool !== "question" || part.status !== "completed") return [];
	const questions = Array.isArray(part.input?.questions)
		? (part.input.questions as Question[])
		: [];
	const answers = answersFromQuestionOutput(questions, part.output);
	if (!answers) return [];
	const requestId = `question-call:${part.callId}`;
	return [
		questionRequestedToUpdate({ requestId, questions }),
		questionResolvedToUpdate({ requestId, answers }),
	];
}

/** The reasoning part a running turn is still writing: the last part of the
 * last message, when the session is busy. Its block is open on any client
 * that has seen it. */
function trailingReasoning(transcript: Transcript): string | null {
	if (transcript.status !== "busy" && transcript.status !== "retry") return null;
	const last = (transcript.messages ?? []).at(-1);
	const part = (last?.parts ?? []).at(-1);
	return part?.type === "reasoning" && part.text ? part.id : null;
}

/** Seed live part routing from a transcript: each part's type, so a delta
 * for a part announced before it still routes, and the open block of a
 * reasoning part still being written (the caller leaves it open too). The
 * SSE bridge also calls it alone when a reconnect resumes from a cursor and
 * no snapshot is replayed. */
export function seedThinking(transcript: Transcript, state: ThinkingState): void {
	for (const { parts } of transcript.messages ?? []) {
		for (const part of parts ?? []) {
			if (part.role === "user") continue;
			if (part.type === "reasoning") state.kinds.set(part.id, "reasoning");
			else if (part.type === "text" && !part.synthetic) state.kinds.set(part.id, "text");
		}
	}
	state.openPart = trailingReasoning(transcript);
}

/** A transcript's messages → the panel's message frames, in order — the one
 * per-message code path `snapshotToUpdates` and the history route (§6
 * `session.history`'s older pages) share, so a page renders exactly as the
 * same message would have in the snapshot. Nothing but the messages: no
 * permissions, questions, status, todos or usage — live state no older page
 * carries.
 *
 * `openPart`, when given, is a reasoning part still being written (the
 * caller leaves it open, so the deltas that follow continue its block);
 * older pages pass the default and render every part closed. */
export function transcriptMessagesToUpdates(
	transcript: Pick<Transcript, "messages">,
	imageUrl?: ToolImageUrl,
	openPart: string | null = null,
	/** Frames to emit right after the named message's parts (the task plan,
	 * after the message that last wrote it). */
	after?: { messageId: string; updates: AgentStreamUpdate[] }
): AgentStreamUpdate[] {
	const updates: AgentStreamUpdate[] = [];
	// The protocol types these lists as arrays, but a machine that omits an
	// empty one (Go's nil slices) must degrade to "nothing", not a 500.
	for (const { message, parts } of transcript.messages ?? []) {
		const clientMessageId = message.role === "user" ? message.clientMessageId : undefined;
		const command = message.role === "user" ? message.command : undefined;
		updates.push({
			type: "messageBoundary",
			role: message.role,
			messageId: message.id,
			...(message.role === "user" && message.sentBy ? { sentBy: message.sentBy } : {}),
		});
		for (const part of parts ?? []) {
			if (part.type === "reasoning" && part.id === openPart) {
				updates.push(streamToken(THINK_OPEN + part.text));
				continue;
			}
			updates.push(
				...partToUpdates(part, clientMessageId, command, imageUrl),
				...answeredQuestionFromPart(part)
			);
		}
		if (after && message.id === after.messageId) updates.push(...after.updates);
	}
	return updates;
}

/** A whole snapshot (`session.sync`'s `Transcript`, or an offline read) →
 * the panel frames a fresh mount replays.
 *
 * `thinking`, when the caller goes on to tail the session live, is seeded
 * from it (`seedThinking`), and a reasoning part still being written is left
 * open, so the deltas that follow continue its block instead of starting a
 * second. */
export function snapshotToUpdates(
	transcript: Transcript,
	imageUrl?: ToolImageUrl,
	sessionId?: string,
	thinking?: ThinkingState
): AgentStreamUpdate[] {
	const updates: AgentStreamUpdate[] = [];
	let lastAssistantError: string | undefined;
	if (thinking) seedThinking(transcript, thinking);
	const openPart = thinking?.openPart ?? null;
	// The task plan goes where it last changed: right after the message that
	// holds the last `todowrite` call, never at the end of the transcript
	// (galopin keeps the last list for the session's life, so an end-of-list
	// plan repainted an hours-old plan on the newest turn at every open). With
	// no `todowrite` among these messages (none at all, or only on an older page
	// the snapshot does not carry) nothing is emitted. The list is remembered
	// either way, so an identical live `todo` event is not a change.
	const todos = transcript.todos ?? [];
	let planAfter: { messageId: string; updates: AgentStreamUpdate[] } | undefined;
	if (todos.length) {
		rememberTodos(thinking, sessionId ?? "", todos);
		const last = [...(transcript.messages ?? [])]
			.reverse()
			.find(({ parts }) => (parts ?? []).some((p) => p.type === "tool" && p.tool === "todowrite"));
		if (last) {
			planAfter = {
				messageId: last.message.id,
				updates: [todoToUpdate(todos, sessionId)],
			};
		}
	}
	updates.push(...transcriptMessagesToUpdates(transcript, imageUrl, openPart, planAfter));
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "assistant") lastAssistantError = providerRefusalReason(message.error);
	}
	for (const permission of transcript.permissions ?? []) {
		updates.push(permissionRequestToUpdate(permission));
	}
	// The turn may be waiting on a question: a snapshot does not replay
	// question.asked, so offer the ask again from the machine's pending list.
	for (const question of transcript.questions ?? []) {
		updates.push(
			questionRequestedToUpdate({ requestId: question.id, questions: question.questions })
		);
	}
	updates.push(
		statusToTurnState(transcript.status, lastAssistantError, undefined, transcript.retry)
	);
	// After history, never before it: a fresh mount's first paint should show
	// the transcript before the meter, same order a live turn would deliver
	// them in (the usage event trails the turn's own parts).
	if (transcript.usage) updates.push(usageToUpdate(transcript.usage));
	return updates;
}

/** The trailing assistant message's error, if any — what a caller holding a
 * live connection open past this snapshot should seed its own tracked
 * `lastAssistantError` with (spec §8), so a `status: "idle"` event arriving
 * later without a fresh `message` event still maps to the right terminal
 * state. Returned as the failed turn shows it (`providerRefusalReason`), the
 * same shape the fold's own tracking carries. */
export function lastAssistantErrorOf(transcript: Transcript): string | undefined {
	let lastAssistantError: string | undefined;
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "assistant") lastAssistantError = providerRefusalReason(message.error);
	}
	return lastAssistantError;
}

/** Every user message's `clientMessageId`, by message id — what a caller
 * holding a live connection open past this snapshot should seed its own
 * tracked lookup with, so a `part` event arriving later for a message this
 * snapshot already carried still resolves its `clientMessageId` (a `part`
 * event names only `messageId`, never the owning message's own fields). */
export function userMessageIdsOf(transcript: Transcript): Map<string, string> {
	const ids = new Map<string, string>();
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "user" && message.clientMessageId) {
			ids.set(message.id, message.clientMessageId);
		}
	}
	return ids;
}

/** The snapshot's command markers, by message id — the seed for the same
 * live lookup `eventToUpdates` threads into user frames (PROTOCOL.md §7):
 * a marker rides the message, the panel's bubble renders from it. */
export function commandMarkersOf(
	transcript: Transcript
): Map<string, { name: string; arguments: string }> {
	const markers = new Map<string, { name: string; arguments: string }>();
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "user" && message.command) {
			markers.set(message.id, message.command);
		}
	}
	return markers;
}

/** A replayed run of envelopes (`session.sync`'s `events` branch, when the
 * machine's ring buffer still holds the gap) → panel frames, threading
 * `lastAssistantError` and the user-message-id lookup across them the same
 * way a live tail would. Returns both tracked values too, so the caller can
 * keep tracking them for whatever arrives after.
 *
 * `childOf` names the subagent context for envelopes that belong to a
 * descendant of the watched session (matched on the envelope's own
 * session id): their approvals/questions fold as labelled cards and their
 * content folds to `childActivity`, never touching the parent's tracked
 * turn state. */
export function foldEnvelopeEvents(
	envelopes: Envelope[],
	initialLastAssistantError?: string,
	initialUserMessageIds?: Map<string, string>,
	childOf?: (sessionId: string) => ChildContext | undefined,
	initialCommandMarkers?: Map<string, { name: string; arguments: string }>,
	imageUrl?: ToolImageUrl,
	thinking: ThinkingState = newThinkingState()
): {
	updates: AgentStreamUpdate[];
	lastAssistantError: string | undefined;
	userMessageIds: Map<string, string>;
	commandMarkers: Map<string, { name: string; arguments: string }>;
} {
	let lastAssistantError = initialLastAssistantError;
	const userMessageIds = new Map(initialUserMessageIds ?? []);
	const commandMarkers = new Map(initialCommandMarkers ?? []);
	const updates: AgentStreamUpdate[] = [];
	for (const { sessionId, event } of envelopes) {
		const child = childOf?.(sessionId);
		if (!child && event.kind === "message") {
			if (event.message.role === "assistant") {
				lastAssistantError = providerRefusalReason(event.message.error);
			} else if (event.message.clientMessageId) {
				userMessageIds.set(event.message.id, event.message.clientMessageId);
			}
			if (event.message.role === "user" && event.message.command) {
				commandMarkers.set(event.message.id, event.message.command);
			}
		}
		// A provider refusal says so with an HTTP status (PROTOCOL.md §7):
		// remembering its framed reason here is what keeps the hint on the
		// failed turn through the `idle` that follows the error event.
		if (!child && event.kind === "error") {
			lastAssistantError = trackedErrorReason(event) ?? lastAssistantError;
		}
		updates.push(
			...eventToUpdates(
				event,
				lastAssistantError,
				(messageId) => userMessageIds.get(messageId),
				child,
				(messageId) => commandMarkers.get(messageId),
				imageUrl,
				sessionId,
				thinking
			)
		);
	}
	return { updates, lastAssistantError, userMessageIds, commandMarkers };
}

/** A frame's identity for seam de-duplication (the SSE bridge, spec §8):
 * the same item never twice, keyed by wire identity rather than content
 * (R4's fix — a token equal to an earlier one, or a repeated user message
 * like "yes", must never be dropped). */
export function frameKey(update: AgentStreamUpdate): string | null {
	switch (update.type) {
		case MessageUpdateType.Tool:
			return `t:${update.uuid}:${update.subtype}`;
		case MessageUpdateType.Elicitation:
			return update.subtype === MessageElicitationUpdateType.Request
				? `q:${update.request.elicitationId}`
				: `r:${update.elicitationId}`;
		case MessageUpdateType.BackgroundTask:
			// One marker per child per state: a re-delivered running frame
			// (a snapshot replayed over a live tail) never doubles the card,
			// and the completion lands once. Keyed by wire identity (child
			// id, spawning call, state), never by the result text.
			return `b:${update.taskId}:${update.callId ?? ""}:${update.state}`;
		default:
			// Stream tokens, user echoes, plan snapshots and turn states are
			// never de-duplicated by content — identity for those is the
			// envelope's (epoch, seq), which the bridge's cursor already
			// guarantees delivers each exactly once.
			return null;
	}
}
