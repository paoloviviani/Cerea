/**
 * The /code Tasks view's reading of a session: which task list is current,
 * how far along it is, and whether it is worth opening on its own.
 *
 * The list is not stored anywhere new. The agent's todo tool reaches the
 * panel as `Plan` updates — the snapshot and the live stream both go through
 * `todoToUpdate` — and each assistant message keeps its own. The current
 * list is simply the last one in the session, so a reload's snapshot and a
 * live turn read the same.
 */
import type { Message } from "$lib/types/Message";
import { isMessagePlanUpdate } from "$lib/utils/messageUpdates";
import type { MessagePlanUpdate } from "$lib/types/MessageUpdate";

/** Past this many items the completed group starts folded. */
export const TASKS_COMPLETED_FOLD_ABOVE = 8;

export function latestPlan(messages: Message[]): MessagePlanUpdate | null {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		const updates = messages[i].updates ?? [];
		for (let j = updates.length - 1; j >= 0; j -= 1) {
			const update = updates[j];
			if (isMessagePlanUpdate(update)) return update;
		}
	}
	return null;
}

export function planProgress(plan: MessagePlanUpdate | null): { done: number; total: number } {
	const steps = plan?.steps ?? [];
	return { done: steps.filter((step) => step.status === "completed").length, total: steps.length };
}

/** "Active": something is being worked on, or the session is busy with
 * items still to do. A finished or idle list is not worth interrupting for. */
export function planIsActive(plan: MessagePlanUpdate | null, busy: boolean): boolean {
	if (!plan) return false;
	if (plan.steps.some((step) => step.status === "in_progress")) return true;
	return busy && plan.steps.some((step) => step.status === "pending");
}

/** One list, once: the session plus what the list starts with. */
export function planKey(sessionId: string, plan: MessagePlanUpdate): string {
	return `tasks:${sessionId}:${plan.steps[0]?.step ?? ""}`;
}
