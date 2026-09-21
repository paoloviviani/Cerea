import {
	CodeAgentUpdateType,
	type CodeAgentUpdate,
	type CodePermissionRequestUpdate,
	type CodeToolCallStatus,
} from "$lib/types/CodeAgent";
import type {
	AgentPermissionRequest,
	AgentStreamEvent,
	AgentTimelineItem,
} from "@getpaseo/protocol/agent-types";

/**
 * The one place the daemon's shapes become the panel's frames.
 *
 * The daemon's timeline items and stream events are its own vocabulary
 * (`AgentTimelineItem`, `AgentStreamEvent` from the pinned SDK); the panel
 * renders the `CodeAgentUpdate` union from `types/CodeAgent.ts`. The SSE
 * bridge and the timeline snapshot endpoint both translate through here, so
 * a frame means the same thing whichever way it arrived.
 *
 * Items with no panel representation — the agent's private reasoning,
 * compaction bookkeeping, plugin frames, bare notifications — are dropped,
 * deliberately: the transcript shows the conversation and the work, not the
 * provider's internals.
 */

interface TimelineEntryLike {
	item: AgentTimelineItem;
}

function toolStatus(item: { status?: unknown; error?: unknown }): CodeToolCallStatus {
	if (item.status === "running") return "running";
	if (item.error !== null && item.error !== undefined) return "error";
	return "done";
}

/** One timeline entry → zero or one panel frame. */
export function timelineEntryToUpdate(entry: TimelineEntryLike): CodeAgentUpdate | null {
	const item = entry.item;
	switch (item.type) {
		case "user_message":
			return { type: CodeAgentUpdateType.AgentMessage, role: "user", text: item.text };
		case "assistant_message":
			return { type: CodeAgentUpdateType.AgentMessage, role: "agent", text: item.text };
		case "tool_call": {
			const call = item as {
				callId?: string;
				name?: string;
				detail?: unknown;
				status?: unknown;
				error?: unknown;
			};
			return {
				type: CodeAgentUpdateType.ToolCall,
				id: call.callId ?? `${item.type}:${call.name ?? "unknown"}`,
				tool: call.name ?? "unknown",
				status: toolStatus(call),
				...(call.detail ? { input: call.detail as Record<string, unknown> } : {}),
			};
		}
		case "todo": {
			const todos = item.items ?? [];
			return {
				type: CodeAgentUpdateType.Plan,
				goal: todos[0]?.text ?? "",
				steps: todos.map((task) => ({
					title: task.text,
					status:
						task.status === "completed" || task.completed
							? "done"
							: task.status === "in_progress"
								? "active"
								: "pending",
				})),
			};
		}
		case "error":
			return { type: CodeAgentUpdateType.TurnState, state: "error", detail: item.message };
		default:
			// reasoning, notification, compaction, plugin: no panel shape.
			return null;
	}
}

/** A daemon permission request → the panel's blocking card, while it waits. */
export function permissionRequestToUpdate(
	request: AgentPermissionRequest,
	pending: boolean,
	resolution?: "approved" | "denied"
): CodePermissionRequestUpdate {
	const detail = request.detail as Record<string, unknown> | undefined;
	return {
		type: CodeAgentUpdateType.PermissionRequest,
		requestId: request.id,
		description: request.title ?? request.description ?? request.name,
		...(typeof detail?.command === "string" ? { command: detail.command } : {}),
		pending,
		...(resolution ? { resolution } : {}),
	};
}

/** One live stream event → zero or one panel frame. */
export function streamEventToUpdate(event: AgentStreamEvent): CodeAgentUpdate | null {
	switch (event.type) {
		case "permission_requested":
			return permissionRequestToUpdate(event.request, true);
		case "permission_resolved":
			return {
				type: CodeAgentUpdateType.PermissionRequest,
				requestId: event.requestId,
				description: "",
				pending: false,
				resolution: event.resolution.behavior === "allow" ? "approved" : "denied",
			};
		case "turn_started":
			return { type: CodeAgentUpdateType.TurnState, state: "running" };
		case "turn_completed":
			return { type: CodeAgentUpdateType.TurnState, state: "done" };
		case "turn_failed":
			return { type: CodeAgentUpdateType.TurnState, state: "error", detail: event.error };
		case "turn_canceled":
			return { type: CodeAgentUpdateType.TurnState, state: "idle", detail: event.reason };
		case "timeline":
			return timelineEntryToUpdate(event);
		default:
			// thread_started, usage, mode/model changes: bookkeeping the
			// transcript does not render.
			return null;
	}
}
