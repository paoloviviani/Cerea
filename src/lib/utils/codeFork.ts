import type { Message } from "$lib/types/Message";

/**
 * Which assistant messages the /code panel may offer "Fork from here" on,
 * as a set of message ids.
 *
 * Two facts, neither of them the message's own TurnState: the machine's id
 * for the message (`machineMessageId` — the boundary the handoff route cuts
 * the carried history at), and position. Where a turn's ending lands is a
 * fold artifact, not a fact about the message: a turn's `done` parks on its
 * last message only, a next turn's early `running` can adopt the previous
 * turn's finished message and stick it at "running" after its own `done`,
 * and a turn that dies without an answer parks its `failed` on an earlier,
 * finished message. Position is the stable fact: while the session is busy
 * (running or waiting on a permission), the live turn is everything after
 * the last user message; idle, every named message is a fixed point.
 */
export function forkableMessageIds(messages: Message[], sessionBusy: boolean): Set<string> {
	const ids = new Set<string>();
	const lastUser = messages.findLastIndex((message) => message.from === "user");
	for (const [index, message] of messages.entries()) {
		if (message.from !== "assistant" || !message.machineMessageId) continue;
		if (sessionBusy && index > lastUser) continue;
		ids.add(message.id);
	}
	return ids;
}
