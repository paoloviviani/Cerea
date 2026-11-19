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

/** The turn state reason a stopped loop leaves (galopin's `error` event code `loop_stopped`, ADR 0107):
 * the machine's limit for loops is `stop`, so it cancelled the turn. Not a failure: the turn is done. */
export const LOOP_STOPPED_REASON = "loop_stopped";

/** Whether this turn ended because the machine stopped a loop (rendered as a plain line, not an error). */
export function loopStoppedOf(message?: Message): boolean {
	const state = turnStateOf(message);
	return state?.state === "done" && state.reason === LOOP_STOPPED_REASON;
}

/**
 * Why a failed turn died, as the failed-turn banner renders it: the machine's
 * error event framed the provider's own text (PROTOCOL.md §7); an empty
 * reason (an older galopin) renders nothing, which is today's look.
 */
/**
 * The text of the last `status: error` update on a message: what a turn that
 * died on the stream (a spent quota, a provider refusal) tells the user. The
 * chat shows it in the message column rather than as a toast over the composer.
 */
export function streamErrorOf(message?: Message): string | undefined {
	const updates = message?.updates ?? [];
	for (let i = updates.length - 1; i >= 0; i -= 1) {
		const update = updates[i];
		if (update.type === MessageUpdateType.Status && update.status === MessageUpdateStatus.Error) {
			return update.message?.trim() || undefined;
		}
	}
	return undefined;
}

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

/**
 * Stops a re-attach that ends at once, with nothing new, from looping. Each
 * finished re-attach reloads the conversation, which re-triggers the re-attach
 * for the same message; if the turn is not actually advancing (the server
 * ended the stream immediately), that is an endless fetch loop that starves
 * the page. A re-attach for a message state we already re-attached to and got
 * nothing from is delayed with exponential back-off instead of re-run at once;
 * any progress (new updates or a moved cursor) resets it.
 */
export function createReattachGuard(baseDelayMs = 1000, maxDelayMs = 30_000) {
	let lastKey: string | undefined;
	let streak = 0;
	let lastEndedAt = 0;

	const keyOf = (message: Message) =>
		`${message.id}:${message.generationId ?? ""}:${message.materializedSeq ?? 0}:${message.updates?.length ?? 0}:${turnStateOf(message)?.state ?? ""}`;

	return {
		/** 0 = attach now; otherwise wait this many ms (and re-check) before attaching. */
		delayFor(message: Message, now: number): number {
			if (keyOf(message) !== lastKey) return 0;
			const wait = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, streak - 1));
			return Math.max(0, lastEndedAt + wait - now);
		},
		/** Call when a re-attach on `message` (as it was at start) has ended. */
		ended(message: Message, now: number): void {
			const key = keyOf(message);
			streak = key === lastKey ? streak + 1 : 1;
			lastKey = key;
			lastEndedAt = now;
		},
		reset(): void {
			lastKey = undefined;
			streak = 0;
		},
	};
}
