/**
 * The one place the machine's normalized shapes become the panel's frames.
 *
 * Unlike the paseo-era `codeTimeline.ts` this replaces, the wire vocabulary
 * (`$lib/types/machineProtocol.ts`) already tells a part's role directly
 * (`Part.role`), so there is no daemon-status inference needed to tell a
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
	SessionStatus,
	Todo,
	Transcript,
	Usage,
} from "$lib/types/machineProtocol";

let planVersion = 0;

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
	output: string | undefined
): MessageToolResultUpdate {
	const result: ToolResult = {
		status: ToolResultStatus.Success,
		call: { name: tool, parameters: (input ?? {}) as Record<string, string | number | boolean> },
		outputs: output ? [{ text: output }] : [],
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

/** One part → zero or more panel frames. A part upserts in place on the
 * wire (spec §7's text contract); folded here as its current, whole value —
 * a snapshot read and a live `part` event both call this the same way.
 * `clientMessageId` (the owning message's, when it is a user message) rides
 * onto the `user` frame — the key attachments will use once the attachment
 * store lands; the fold ignores it for now. */
function partToUpdates(part: Part, clientMessageId?: string): AgentStreamUpdate[] {
	switch (part.type) {
		case "text":
			if (part.synthetic) return [];
			if (!part.text) return [];
			return part.role === "user"
				? [
						{
							type: "user",
							text: part.text,
							...(clientMessageId ? { messageId: clientMessageId } : {}),
						},
					]
				: [{ type: MessageUpdateType.Stream, token: part.text }];
		case "tool": {
			const call = toolCallUpdate(part.callId, part.tool, part.input);
			if (part.status === "pending" || part.status === "running") return [call];
			if (part.status === "error")
				return [call, toolErrorUpdate(part.callId, part.error ?? "The call failed.")];
			return [call, toolResultUpdate(part.callId, part.tool, part.input, part.output)];
		}
		case "compaction": {
			const update: AgentCompactionUpdate = { type: "compaction", auto: part.auto };
			return [update];
		}
		// reasoning: no panel shape yet. file/subtask: the diff pane and the
		// polled subagent roster are the panel's surfaces for those, not the
		// transcript fold.
		default:
			return [];
	}
}

export function permissionRequestToUpdate(
	request: PermissionRequest
): MessageElicitationRequestUpdate {
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request: {
			elicitationId: request.id,
			server: request.tool,
			mode: "form",
			message: request.title,
			toolApproval: { tool: request.tool, args: request.metadata },
		},
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

function todoToUpdate(todos: Todo[]): MessagePlanUpdate {
	planVersion += 1;
	return {
		type: MessageUpdateType.Plan,
		uuid: `agent-plan-${planVersion}`,
		goal: todos[0]?.content ?? "",
		version: planVersion,
		steps: todos.map((todo) => ({
			step: todo.content,
			status:
				todo.status === "completed"
					? "completed"
					: todo.status === "in_progress"
						? "in_progress"
						: "pending",
		})),
	};
}

function turnStateUpdate(
	state: MessageTurnStateUpdate["state"],
	reason?: string
): MessageTurnStateUpdate {
	return {
		type: MessageUpdateType.TurnState,
		state,
		serverNow: Date.now(),
		...(reason ? { reason } : {}),
	};
}

/** `status` → turn state (spec §8): `busy`/`retry` are running, `idle` is
 * done unless the turn's last assistant message carries an error — that one
 * bit of context the caller supplies, since a bare `status` event does not
 * repeat it. */
function statusToTurnState(
	status: SessionStatus,
	lastAssistantError: string | undefined,
	detail?: string
): MessageTurnStateUpdate {
	switch (status) {
		case "busy":
		case "retry":
			return turnStateUpdate("running", detail);
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
 * `message` event that named it) supplies the lookup. */
export function eventToUpdates(
	event: NormalizedEvent,
	lastAssistantError?: string,
	resolveClientMessageId?: (messageId: string) => string | undefined
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
			};
			return [boundary];
		}
		case "part":
			return partToUpdates(
				event.part,
				event.part.role === "user" ? resolveClientMessageId?.(event.part.messageId) : undefined
			);
		case "delta":
			return event.field === "text" ? [{ type: MessageUpdateType.Stream, token: event.delta }] : [];
		case "part.removed":
			return [];
		case "status":
			return [statusToTurnState(event.status, lastAssistantError, event.detail)];
		case "permission.asked":
			return [permissionRequestToUpdate(event.request)];
		case "permission.replied":
			return [permissionResolvedToUpdate(event.requestId, event.decision)];
		case "usage":
			return [usageToUpdate(event.usage)];
		case "session":
			return []; // metadata changed; the panel re-reads via its own poll.
		case "error":
			return [turnStateUpdate("failed", event.message)];
		case "todo":
			return [todoToUpdate(event.todos)];
		default:
			return [];
	}
}

/** A whole snapshot (`session.sync`'s `Transcript`, or an offline read) →
 * the panel frames a fresh mount replays. */
export function snapshotToUpdates(transcript: Transcript): AgentStreamUpdate[] {
	const updates: AgentStreamUpdate[] = [];
	let lastAssistantError: string | undefined;
	// The protocol types these lists as arrays, but a machine that omits an
	// empty one (Go's nil slices) must degrade to "nothing", not a 500.
	for (const { message, parts } of transcript.messages ?? []) {
		const clientMessageId = message.role === "user" ? message.clientMessageId : undefined;
		updates.push({ type: "messageBoundary", role: message.role, messageId: message.id });
		for (const part of parts ?? []) updates.push(...partToUpdates(part, clientMessageId));
		if (message.role === "assistant") lastAssistantError = message.error;
	}
	for (const permission of transcript.permissions ?? []) {
		updates.push(permissionRequestToUpdate(permission));
	}
	const todos = transcript.todos ?? [];
	if (todos.length) updates.push(todoToUpdate(todos));
	updates.push(statusToTurnState(transcript.status, lastAssistantError));
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
 * state. */
export function lastAssistantErrorOf(transcript: Transcript): string | undefined {
	let lastAssistantError: string | undefined;
	for (const { message } of transcript.messages ?? []) {
		if (message.role === "assistant") lastAssistantError = message.error;
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

/** A replayed run of envelopes (`session.sync`'s `events` branch, when the
 * machine's ring buffer still holds the gap) → panel frames, threading
 * `lastAssistantError` and the user-message-id lookup across them the same
 * way a live tail would. Returns both tracked values too, so the caller can
 * keep tracking them for whatever arrives after. */
export function foldEnvelopeEvents(
	envelopes: Envelope[],
	initialLastAssistantError?: string,
	initialUserMessageIds?: Map<string, string>
): {
	updates: AgentStreamUpdate[];
	lastAssistantError: string | undefined;
	userMessageIds: Map<string, string>;
} {
	let lastAssistantError = initialLastAssistantError;
	const userMessageIds = new Map(initialUserMessageIds ?? []);
	const updates: AgentStreamUpdate[] = [];
	for (const { event } of envelopes) {
		if (event.kind === "message") {
			if (event.message.role === "assistant") {
				lastAssistantError = event.message.error;
			} else if (event.message.clientMessageId) {
				userMessageIds.set(event.message.id, event.message.clientMessageId);
			}
		}
		updates.push(
			...eventToUpdates(event, lastAssistantError, (messageId) => userMessageIds.get(messageId))
		);
	}
	return { updates, lastAssistantError, userMessageIds };
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
		default:
			// Stream tokens, user echoes, plan snapshots and turn states are
			// never de-duplicated by content — identity for those is the
			// envelope's (epoch, seq), which the bridge's cursor already
			// guarantees delivers each exactly once.
			return null;
	}
}
