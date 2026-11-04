import type { Message } from "$lib/types/Message";
import { MessageUpdateType } from "$lib/types/MessageUpdate";
import type { SessionRef } from "$lib/stores/codeNeedsYou.svelte";

/**
 * The coding-agent sessions a conversation started or prompted (ADR 0106),
 * read from the `agentSession` updates its messages keep: one entry per
 * session, in first-seen order.
 */
export function agentSessionsOf(messages: Message[]): SessionRef[] {
	const seen = new Set<string>();
	const out: SessionRef[] = [];
	for (const message of messages) {
		for (const update of message.updates ?? []) {
			if (update.type !== MessageUpdateType.AgentSession) continue;
			const key = `${update.deviceId}:${update.sessionId}`;
			if (seen.has(key)) continue;
			seen.add(key);
			out.push({ deviceId: update.deviceId, sessionId: update.sessionId });
		}
	}
	return out;
}
