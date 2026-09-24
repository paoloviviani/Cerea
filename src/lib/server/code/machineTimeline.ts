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
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";
import { ToolResultStatus, type ToolResult } from "$lib/types/Tool";
import type {
	Envelope,
	NormalizedEvent,
	Part,
	PermissionRequest,
	SessionStatus,
	Todo,
	Transcript,
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
		call: { name: tool, parameters: input as Record<string, string | number | boolean> },
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
		call: { name: tool, parameters: input as Record<string, string | number | boolean> },
		outputs: output ? [{ text: output }] : [],
		display: true,
	};
	return { type: MessageUpdateType.Tool, subtype: MessageToolUpdateType.Result, uuid: callId, result };
}

function toolErrorUpdate(callId: string, message: string): MessageToolErrorUpdate {
	return { type: MessageUpdateType.Tool, subtype: MessageToolUpdateType.Error, uuid: callId, message };
}

/** One part → zero or more panel frames. A part upserts in place on the
 * wire (spec §7's text contract); folded here as its current, whole value —
 * a snapshot read and a live `part` event both call this the same way. */
function partToUpdates(part: Part): AgentStreamUpdate[] {
	switch (part.type) {
		case "text":
			if (part.synthetic) return [];
			if (!part.text) return [];
			return part.role === "user"
				? [{ type: "user", text: part.text }]
				: [{ type: MessageUpdateType.Stream, token: part.text }];
		case "tool": {
			const call = toolCallUpdate(part.callId, part.tool, part.input);
			if (part.status === "pending" || part.status === "running") return [call];
			if (part.status === "error") return [call, toolErrorUpdate(part.callId, part.error ?? "The call failed.")];
			return [call, toolResultUpdate(part.callId, part.tool, part.input, part.output)];
		}
		// reasoning: no panel shape yet. file/subtask: the diff pane and the
		// polled subagent roster are the panel's surfaces for those, not the
		// transcript fold.
		default:
			return [];
	}
}

export function permissionRequestToUpdate(request: PermissionRequest): MessageElicitationRequestUpdate {
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

function turnStateUpdate(state: MessageTurnStateUpdate["state"], reason?: string): MessageTurnStateUpdate {
	return { type: MessageUpdateType.TurnState, state, serverNow: Date.now(), ...(reason ? { reason } : {}) };
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
 * a `status: "idle"` event. */
export function eventToUpdates(
	event: NormalizedEvent,
	lastAssistantError?: string
): AgentStreamUpdate[] {
	switch (event.kind) {
		case "message":
			return []; // metadata only; text arrives as a part event on the same message.
		case "part":
			return partToUpdates(event.part);
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
			return []; // a side channel (M3), no chat frame shape yet.
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
	for (const { message, parts } of transcript.messages) {
		for (const part of parts) updates.push(...partToUpdates(part));
		if (message.role === "assistant") lastAssistantError = message.error;
	}
	for (const permission of transcript.permissions) {
		updates.push(permissionRequestToUpdate(permission));
	}
	if (transcript.todos.length) updates.push(todoToUpdate(transcript.todos));
	updates.push(statusToTurnState(transcript.status, lastAssistantError));
	return updates;
}

/** The trailing assistant message's error, if any — what a caller holding a
 * live connection open past this snapshot should seed its own tracked
 * `lastAssistantError` with (spec §8), so a `status: "idle"` event arriving
 * later without a fresh `message` event still maps to the right terminal
 * state. */
export function lastAssistantErrorOf(transcript: Transcript): string | undefined {
	let lastAssistantError: string | undefined;
	for (const { message } of transcript.messages) {
		if (message.role === "assistant") lastAssistantError = message.error;
	}
	return lastAssistantError;
}

/** A replayed run of envelopes (`session.sync`'s `events` branch, when the
 * machine's ring buffer still holds the gap) → panel frames, threading
 * `lastAssistantError` across them the same way a live tail would. Returns
 * the final tracked error too, so the caller can keep tracking it for
 * whatever arrives after. */
export function foldEnvelopeEvents(
	envelopes: Envelope[],
	initialLastAssistantError?: string
): { updates: AgentStreamUpdate[]; lastAssistantError: string | undefined } {
	let lastAssistantError = initialLastAssistantError;
	const updates: AgentStreamUpdate[] = [];
	for (const { event } of envelopes) {
		if (event.kind === "message" && event.message.role === "assistant") {
			lastAssistantError = event.message.error;
		}
		updates.push(...eventToUpdates(event, lastAssistantError));
	}
	return { updates, lastAssistantError };
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
