import { v4 } from "uuid";
import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";
import type { AgentStreamUpdate } from "$lib/types/CodeAgent";

/**
 * Apply the agent frame stream to a reactive `Message[]` the UI renders.
 *
 * The agent counterpart of `consumeMessageUpdates`: that one folds one
 * assistant turn into one message; this one owns the turn structure too,
 * because the daemon's log carries both sides of the conversation. A `user`
 * frame opens a turn with a user message; the turn's work — tokens, tools,
 * plans, approval cards, turn state — folds into the one assistant message
 * that follows, exactly the shape `ChatMessage` already renders. Both
 * channels (a fresh subscription's history replay and the live tail) go
 * through this one fold, so a reloaded transcript converges on the same
 * shape a live one builds.
 *
 * Token buffering follows the chat's discipline: tokens accumulate in a
 * string and flush on a frame boundary — non-stream frames flush first so
 * text never appears cut mid-sentence beside the tool that caused it — and
 * on a requestAnimationFrame cadence, so a fast stream re-renders per frame
 * rather than per token. `updates` is buffered alongside content for the
 * same reason.
 */

export interface AgentConsumeContext {
	isAborted: () => boolean;
	onAbort: () => void;
	/** A turn-state frame arrived; the view drops its pending placeholder. */
	onTurnEvent: () => void;
}

export async function consumeAgentUpdates(
	iterator: AsyncGenerator<AgentStreamUpdate>,
	messages: Message[],
	ctx: AgentConsumeContext
): Promise<void> {
	/** The current turn's assistant message; null between turns. */
	let current: Message | null = null;
	let buffer = "";
	// Local authoritative copy of the open message's updates during streaming.
	// Assigning the reactive field per frame re-renders the whole message;
	// buffer and flush on the content cadence instead.
	let updatesBuffer: MessageUpdate[] = [];
	let updatesDirty = false;
	let frameFlushScheduled = false;
	/** Daemon call ids that already emitted their Call / their closing frame. */
	const toolOpen = new Set<string>();
	const toolClosed = new Set<string>();

	const flushBuffer = () => {
		if (!current) {
			buffer = "";
			return;
		}
		if (buffer.length > 0) {
			current.content += buffer;
			buffer = "";
		}
		if (updatesDirty) {
			current.updates = updatesBuffer;
			updatesDirty = false;
		}
	};

	const scheduleFrameFlush = () => {
		if (frameFlushScheduled) return;
		frameFlushScheduled = true;
		const flush = () => {
			frameFlushScheduled = false;
			flushBuffer();
		};
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(flush);
		} else {
			setTimeout(flush, 0);
		}
	};

	/** The turn's assistant message, created on first use. */
	function openAssistant(): Message {
		if (current) return current;
		flushBuffer();
		const message: Message = { id: v4(), from: "assistant", content: "", children: [] };
		messages.push(message);
		current = message;
		updatesBuffer = [];
		updatesDirty = false;
		return message;
	}

	/** Close the current turn; the next frame opens a fresh message. */
	function closeTurn() {
		flushBuffer();
		current = null;
	}

	function pushUpdate(update: MessageUpdate) {
		updatesBuffer = [...updatesBuffer, update];
		updatesDirty = true;
	}

	/** Where a turn-state frame lands: the open message, else the transcript's
	 * last assistant message (a completion re-derived after a reconnect). */
	function stateTarget(): Message | null {
		if (current) return current;
		for (let i = messages.length - 1; i >= 0; i -= 1) {
			const candidate = messages[i];
			if (candidate.from === "assistant") return candidate;
		}
		return null;
	}

	/**
	 * Adopt the running turn. After a user echo the turn is brand new (last
	 * message is the user's) and gets a fresh message; on a mid-run mount the
	 * trailing assistant message IS the running turn's, so its remaining
	 * deltas continue into it rather than splitting the bubble.
	 */
	function adoptRunning(): Message {
		if (current) return current;
		const last = messages.at(-1);
		if (last && last.from === "assistant") {
			current = last;
			updatesBuffer = [...(last.updates ?? [])];
			updatesDirty = false;
			return last;
		}
		return openAssistant();
	}

	/** Attach an update to a message that may not be the buffered one. */
	function attach(target: Message, update: MessageUpdate) {
		if (target === current) {
			pushUpdate(update);
			flushBuffer();
			return;
		}
		target.updates = [...(target.updates ?? []), update];
	}

	for await (const update of iterator) {
		if (ctx.isAborted()) {
			// Commit anything still buffered: the navigation-abort path skips
			// any post-stream reconciliation, so a dropped buffer would be
			// lost from the UI.
			flushBuffer();
			ctx.onAbort();
			return;
		}

		switch (update.type) {
			case "user": {
				closeTurn();
				messages.push({ id: v4(), from: "user", content: update.text, children: [] });
				break;
			}
			case MessageUpdateType.Stream: {
				openAssistant();
				const last = updatesBuffer.at(-1);
				if (last?.type === MessageUpdateType.Stream) {
					updatesBuffer = [
						...updatesBuffer.slice(0, -1),
						{ ...last, token: last.token + update.token },
					];
				} else {
					pushUpdate(update);
				}
				updatesDirty = true;
				buffer += update.token;
				scheduleFrameFlush();
				break;
			}
			case MessageUpdateType.Tool: {
				flushBuffer();
				openAssistant();
				if (update.subtype === MessageToolUpdateType.Call) {
					if (toolOpen.has(update.uuid)) break;
					toolOpen.add(update.uuid);
					pushUpdate(update);
					flushBuffer();
					break;
				}
				// A closing frame for a call this fold never saw (a seam the
				// bridge re-derived): synthesize the Call so the card pairs.
				if (!toolOpen.has(update.uuid)) {
					toolOpen.add(update.uuid);
					pushUpdate({
						type: MessageUpdateType.Tool,
						subtype: MessageToolUpdateType.Call,
						uuid: update.uuid,
						call:
							update.subtype === MessageToolUpdateType.Result
								? update.result.call
								: { name: "unknown", parameters: {} },
					});
				}
				if (toolClosed.has(update.uuid)) break;
				toolClosed.add(update.uuid);
				pushUpdate(update);
				flushBuffer();
				break;
			}
			case MessageUpdateType.Plan: {
				flushBuffer();
				openAssistant();
				pushUpdate(update);
				flushBuffer();
				break;
			}
			case MessageUpdateType.Elicitation: {
				if (update.subtype === MessageElicitationUpdateType.Request) {
					flushBuffer();
					openAssistant();
					pushUpdate(update);
					flushBuffer();
					break;
				}
				// A resolution settles the card that asked, wherever it lives —
				// the transcript, not the open turn, owns the pairing.
				const target = [...messages]
					.reverse()
					.find(
						(message) =>
							message.from === "assistant" &&
							(message.updates ?? []).some(
								(candidate) =>
									candidate.type === MessageUpdateType.Elicitation &&
									candidate.subtype === MessageElicitationUpdateType.Request &&
									candidate.request.elicitationId === update.elicitationId
							)
					);
				if (target) attach(target, update);
				break;
			}
			case MessageUpdateType.TurnState: {
				flushBuffer();
				ctx.onTurnEvent();
				if (update.state === "running") {
					adoptRunning();
					pushUpdate(update);
					flushBuffer();
					break;
				}
				const target = stateTarget();
				if (target) attach(target, update);
				closeTurn();
				break;
			}
			default:
				break;
		}
	}

	flushBuffer();
}
