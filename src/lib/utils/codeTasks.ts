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

function planOf(message: Message): MessagePlanUpdate | null {
	const updates = message.updates ?? [];
	for (let j = updates.length - 1; j >= 0; j -= 1) {
		const update = updates[j];
		if (isMessagePlanUpdate(update)) return update;
	}
	return null;
}

/** The answer for every message but the last (which is still streaming, so
 * it is always read fresh): `head`/`tail` are the first and last message it
 * covers, so a different session or a rewritten history drops it. */
let cache: {
	head: Message;
	tail: Message;
	prefixLen: number;
	plan: MessagePlanUpdate | null;
} | null = null;

/** Streaming re-derives this per frame, and a session with no list would
 * walk every update each time — so only messages appended since the last
 * call are scanned, and the last message is always re-read. */
export function latestPlan(messages: Message[]): MessagePlanUpdate | null {
	const prefixLen = messages.length - 1;
	if (prefixLen < 0) {
		cache = null;
		return null;
	}
	const fromLast = planOf(messages[prefixLen]);
	if (fromLast) return fromLast;
	if (prefixLen === 0) {
		cache = null;
		return null;
	}

	const prior =
		cache !== null &&
		cache.prefixLen <= prefixLen &&
		cache.head === messages[0] &&
		messages[cache.prefixLen - 1] === cache.tail
			? cache
			: null;
	let plan: MessagePlanUpdate | null = null;
	for (let i = prefixLen - 1; i >= (prior?.prefixLen ?? 0) && !plan; i -= 1) {
		plan = planOf(messages[i]);
	}
	if (!plan && prior) plan = prior.plan;

	cache = { head: messages[0], tail: messages[prefixLen - 1], prefixLen, plan };
	return plan;
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

/** One list, once: the session plus what the list starts with.
 *
 * Known gap, accepted: a genuinely new list that happens to start with the
 * same first item has the same key, so it does not auto-open again. That
 * fails quietly (the pane is one tap away) and a sturdier key would need
 * an identity the agent's todo tool does not give us. */
export function planKey(sessionId: string, plan: MessagePlanUpdate): string {
	return `tasks:${sessionId}:${plan.steps[0]?.step ?? ""}`;
}
