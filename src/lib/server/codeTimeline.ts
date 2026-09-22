import type {
	AgentPermissionRequest,
	AgentStreamEvent,
	AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
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
import type { AgentStreamUpdate, CodeTurnState } from "$lib/types/CodeAgent";
import { ToolResultStatus, type ToolResult } from "$lib/types/Tool";

/**
 * The one place the daemon's shapes become the panel's frames.
 *
 * The daemon's timeline items and stream events are its own vocabulary
 * (`AgentTimelineItem`, `AgentStreamEvent` from the pinned SDK); the panel
 * renders the chat's `MessageUpdate` shapes, so a transcript folds through
 * the same consumer that renders a conversation. The agent-only frame (the
 * user's message, which chats author client-side) lives in
 * `types/CodeAgent.ts` beside the union. The SSE bridge and the timeline
 * snapshot endpoints both translate through here, so a frame means the same
 * thing whichever way it arrived.
 *
 * Items with no panel representation — the agent's private reasoning,
 * compaction bookkeeping, plugin frames, bare notifications — are dropped,
 * deliberately: the transcript shows the conversation and the work, not the
 * provider's internals.
 */

interface TimelineEntryLike {
	item: AgentTimelineItem;
}

/**
 * Plan snapshots replace each other in place (ChatMessage keeps one live
 * card), but each needs a distinct version for the render key. The daemon
 * has no version of its own, so translation hands one out. A module counter
 * is enough: uniqueness is required within one rendered message, and every
 * replay maps its snapshots in order.
 */
let planVersion = 0;

/** The primitive-valued fields a tool's detail carries, as the chat's
 * `ToolCall.parameters` wants them — the human-meaningful ones a person
 * unfolds the card to read. */
function toolParameters(
	detail: ToolCallDetail | undefined
): Record<string, string | number | boolean> {
	switch (detail?.type) {
		case "shell":
			return { ...(detail.command ? { command: detail.command } : {}) };
		case "read":
		case "edit":
		case "write":
			return { filePath: detail.filePath };
		case "search":
			return { ...(detail.query ? { query: detail.query } : {}) };
		case "fetch":
			return { url: detail.url };
		case "sub_agent":
			return { ...(detail.description ? { description: detail.description } : {}) };
		case "plain_text":
			return { ...(detail.label ? { label: detail.label } : {}) };
		case "plan":
			return { text: detail.text };
		default:
			return {};
	}
}

/** What the call produced, when the detail carries a readable side. */
function toolOutput(detail: ToolCallDetail | undefined): string | undefined {
	switch (detail?.type) {
		case "shell":
			return detail.output;
		case "read":
			return detail.content;
		case "edit":
			return detail.unifiedDiff;
		case "search":
			return detail.content;
		case "fetch":
			return detail.result;
		default:
			return undefined;
	}
}

function errorText(error: unknown): string {
	if (typeof error === "string" && error.trim()) return error;
	if (error && typeof error === "object" && "message" in error) {
		const message = (error as { message?: unknown }).message;
		if (typeof message === "string" && message.trim()) return message;
	}
	return "The call failed.";
}

function toolCallUpdate(
	callId: string,
	name: string,
	detail: ToolCallDetail | undefined
): MessageToolCallUpdate {
	return {
		type: MessageUpdateType.Tool,
		subtype: MessageToolUpdateType.Call,
		uuid: callId,
		call: { name, parameters: toolParameters(detail) },
	};
}

function toolResultUpdate(
	callId: string,
	name: string,
	detail: ToolCallDetail | undefined
): MessageToolResultUpdate {
	const output = toolOutput(detail);
	const result: ToolResult = {
		status: ToolResultStatus.Success,
		call: { name, parameters: toolParameters(detail) },
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

/** One timeline entry → zero or more panel frames. */
export function timelineEntryToUpdate(entry: TimelineEntryLike): AgentStreamUpdate[] {
	const item = entry.item;
	switch (item.type) {
		case "user_message":
			return [{ type: "user", text: item.text }];
		case "assistant_message":
			// The daemon logs an item per text delta; chat folds deltas as
			// Stream updates into the turn's one assistant message.
			return [{ type: MessageUpdateType.Stream, token: item.text }];
		case "tool_call": {
			const call = item as {
				callId?: string;
				name?: string;
				detail?: ToolCallDetail;
				status?: unknown;
				error?: unknown;
			};
			const callId = call.callId ?? `${item.type}:${call.name ?? "unknown"}`;
			const name = call.name ?? "unknown";
			const callUpdate = toolCallUpdate(callId, name, call.detail);
			if (call.status === "running") return [callUpdate];
			if (call.status === "failed" || call.status === "canceled") {
				return [
					callUpdate,
					toolErrorUpdate(callId, call.status === "canceled" ? "Canceled." : errorText(call.error)),
				];
			}
			return [callUpdate, toolResultUpdate(callId, name, call.detail)];
		}
		case "todo": {
			const todos = item.items ?? [];
			planVersion += 1;
			const update: MessagePlanUpdate = {
				type: MessageUpdateType.Plan,
				uuid: `agent-plan-${planVersion}`,
				goal: todos[0]?.text ?? "",
				version: planVersion,
				steps: todos.map((task) => ({
					step: task.text,
					status:
						task.status === "completed" || task.completed
							? "completed"
							: task.status === "in_progress"
								? "in_progress"
								: "pending",
				})),
			};
			return [update];
		}
		case "error":
			return [turnStateUpdate("failed", item.message)];
		default:
			// reasoning, notification, compaction, plugin: no panel shape.
			return [];
	}
}

function turnStateUpdate(
	state: MessageTurnStateUpdate["state"],
	detail?: string
): MessageTurnStateUpdate {
	return {
		type: MessageUpdateType.TurnState,
		state,
		serverNow: Date.now(),
		...(detail ? { reason: detail } : {}),
	};
}

/**
 * The daemon permission, dressed as the chat's tool-approval elicitation so
 * the conversation's own approval card renders it: the command (or the
 * request's title) plays the tool, the daemon's detail plays the arguments.
 * No expiry: a daemon permission waits until answered, like a 2026-era
 * prompt.
 */
export function permissionRequestToUpdate(
	request: AgentPermissionRequest
): MessageElicitationRequestUpdate {
	const detail = (request.detail ?? {}) as Record<string, unknown>;
	const command = typeof detail.command === "string" ? detail.command : undefined;
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request: {
			elicitationId: request.id,
			server: request.provider,
			mode: "form",
			message: request.description ?? request.title ?? request.name,
			toolApproval: {
				tool: command?.split("\n")[0] ?? request.title ?? request.name,
				args: detail,
			},
		},
	};
}

export function permissionResolvedToUpdate(
	requestId: string,
	behavior: "allow" | "deny"
): MessageElicitationResolvedUpdate {
	return {
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Resolved,
		elicitationId: requestId,
		action: behavior === "allow" ? "accept" : "decline",
		resolution: "user",
	};
}

/** The agent's own status, as the turn state a mid-run mount should adopt. */
export function agentStatusTurnState(status: string): MessageTurnStateUpdate | null {
	if (status === "running") return turnStateUpdate("running");
	if (status === "error") return turnStateUpdate("failed", "The turn failed.");
	if (status === "closed") return turnStateUpdate("done");
	return null;
}

/** One live stream event → zero or more panel frames. */
export function streamEventToUpdate(event: AgentStreamEvent): AgentStreamUpdate[] {
	switch (event.type) {
		case "permission_requested":
			return [permissionRequestToUpdate(event.request)];
		case "permission_resolved":
			return [permissionResolvedToUpdate(event.requestId, event.resolution.behavior)];
		case "turn_started":
			return [turnStateUpdate("running")];
		case "turn_completed":
			return [turnStateUpdate("done")];
		case "turn_failed":
			return [turnStateUpdate("failed", event.error)];
		case "turn_canceled":
			return [turnStateUpdate("done", event.reason)];
		case "timeline":
			return timelineEntryToUpdate(event);
		default:
			// thread_started, usage, mode/model changes: bookkeeping the
			// transcript does not render.
			return [];
	}
}

/** The session state the pills show, from the turn state a frame reported. */
export function sessionStateFromTurnState(update: MessageTurnStateUpdate): CodeTurnState {
	switch (update.state) {
		case "running":
			return "running";
		case "failed":
			return "error";
		case "done":
			return "done";
		default:
			return "idle";
	}
}
