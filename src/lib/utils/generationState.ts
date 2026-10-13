import type { Message } from "$lib/types/Message";
import {
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageTurnStateUpdate,
} from "$lib/types/MessageUpdate";

/**
 * The last in-band turn state this message carries — the client's authoritative
 * liveness, delivered and replayed on the same channel as everything else. No
 * inference over event patterns: the state IS the data (see TurnState.ts).
 */
export function turnStateOf(message?: Message): MessageTurnStateUpdate | undefined {
	if (!message || message.from !== "assistant") return undefined;
	const updates = message.updates ?? [];
	for (let i = updates.length - 1; i >= 0; i -= 1) {
		const update = updates[i];
		if (update.type === MessageUpdateType.TurnState) return update;
	}
	return undefined;
}

/**
 * Why a failed turn died, as the failed-turn banner renders it: the machine's
 * error event framed the provider's own text (PROTOCOL.md §7); an empty
 * reason (an older galopin) renders nothing, which is today's look.
 */
export function failedTurnReasonOf(message?: Message): string | undefined {
	const state = turnStateOf(message);
	return state?.state === "failed" && state.reason ? state.reason : undefined;
}

/**
 * The transcript's most recent failed turn — the last message that would
 * render the failed-turn banner. The message column hands this to its
 * messages so only that banner starts expanded; older ones start collapsed.
 */
export function lastFailedTurnId(messages: Message[]): Message["id"] | undefined {
	for (let i = messages.length - 1; i >= 0; i -= 1) {
		if (failedTurnReasonOf(messages[i]) !== undefined) return messages[i].id;
	}
	return undefined;
}

/**
 * Messages persisted before turn states carry only lifecycle statuses, whose
 * LAST event decides (each park stamped `finished`, each resume `started`).
 * Kept solely for those messages — delete when pre-turn-state conversations
 * have aged out.
 */
function legacyTerminal(message: Message): boolean {
	const updates = message.updates ?? [];
	for (let i = updates.length - 1; i >= 0; i -= 1) {
		const update = updates[i];
		if (update.type === MessageUpdateType.FinalAnswer) return true;
		if (update.type === MessageUpdateType.Status) {
			if (
				update.status === MessageUpdateStatus.Error ||
				update.status === MessageUpdateStatus.Finished
			) {
				return true;
			}
			if (update.status === MessageUpdateStatus.Started) return false;
		}
	}
	return false;
}

/**
 * Whether the assistant message is past generation FOR UI PURPOSES — the
 * loading spinner, scroll following, the stop button. Only a running turn is
 * non-terminal: a waiting turn reads terminal here (the wait banner is its
 * affordance, not the spinner), and whether the turn's channel still has
 * something to say is the separate question `isTurnSubscribable` answers.
 */
export function isAssistantGenerationTerminal(message?: Message): boolean {
	if (!message || message.from !== "assistant") return true;

	if (message.interrupted === true) return true;

	const state = turnStateOf(message);
	if (state) return state.state !== "running";
	return legacyTerminal(message);
}

export function isConversationGenerationActive(messages: Message[]): boolean {
	const lastAssistant = [...messages].reverse().find((message) => message.from === "assistant");
	if (!lastAssistant) return false;

	return !isAssistantGenerationTerminal(lastAssistant);
}

/**
 * Whether the turn's channel can still deliver events, i.e. whether this tab
 * should hold a subscription. Running and waiting turns, obviously — the
 * whole point is that a resume arrives on the held connection. A turn
 * awaiting input too: an answer (possibly from another tab or device)
 * continues the same turn log, and the open subscription is how every other
 * view sees it live.
 */
export function isTurnSubscribable(message?: Message): boolean {
	if (!message || message.from !== "assistant" || message.interrupted === true) return false;

	const state = turnStateOf(message);
	if (state) {
		return (
			state.state === "running" || state.state === "waiting" || state.state === "awaiting_input"
		);
	}
	return !legacyTerminal(message);
}
