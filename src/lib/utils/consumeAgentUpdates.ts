import { v4 } from "uuid";
import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";
import type {
	AgentCompactionUpdate,
	AgentStreamUpdate,
	AgentUsageUpdate,
} from "$lib/types/CodeAgent";

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
	/** The machine's epoch changed (`reset`): the transcript was just
	 * discarded and rebuilt, and the side channel's tracked usage/compaction
	 * are stale the same way — the caller clears them here. */
	onReset?: () => void;
	/** A `usage` side-channel frame arrived. Never touches turn structure —
	 * the latest value simply replaces whatever the view is holding. */
	onUsage?: (usage: AgentUsageUpdate["usage"]) => void;
	/** A `compaction` side-channel frame arrived. Same discipline as `onUsage`. */
	onCompaction?: (update: AgentCompactionUpdate) => void;
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
	let frameFlushTimer: ReturnType<typeof setTimeout> | null = null;
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

	// One commit per paint frame, never one per frame off the wire: a
	// tool-heavy turn or a replayed history arrives as a burst of frames,
	// and a synchronous reactive write per frame re-derives the whole
	// message (blocks, markdown) per frame — saturating the main thread
	// until input stops landing, which reads as a freeze. This is the
	// discipline paseo's own app applies to the same daemon stream (its
	// reducer queue commits on a RAF with a timer fallback for hidden
	// tabs, where RAF never fires but the transcript must still advance).
	const scheduleFrameFlush = () => {
		if (frameFlushScheduled) return;
		frameFlushScheduled = true;
		const flush = () => {
			if (frameFlushTimer) {
				clearTimeout(frameFlushTimer);
				frameFlushTimer = null;
			}
			frameFlushScheduled = false;
			flushBuffer();
		};
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(flush);
			// RAF never fires in a hidden tab; the timer (48ms — the same
			// ceiling paseo's reducer queue allows) keeps the transcript
			// advancing when nothing paints.
			frameFlushTimer = setTimeout(flush, 48);
		} else {
			setTimeout(flush, 0);
		}
	};

	/** The turn's assistant message, created on first use. The local buffer
	 * joins the new message (the scheduled flush commits it); no forced
	 * synchronous commit here — `openAssistant` runs per frame off the
	 * wire, and a forced flush would restore the per-frame render storm
	 * the scheduling exists to prevent. */
	function openAssistant(): Message {
		if (current) return current;
		const message: Message = { id: v4(), from: "assistant", content: buffer, children: [] };
		buffer = "";
		messages.push(message);
		// Re-read through the array, never keep the local reference: in the
		// browser `messages` is a $state proxy, and mutating the raw object
		// that was just pushed bypasses the proxy's traps — the content
		// lands in the data and the DOM never re-renders it (the answer
		// that only appears after a remount). Reading the slot back returns
		// the proxied message, whose mutations invalidate what tracks it.
		// In tests the array is plain and the read returns the same object.
		current = messages[messages.length - 1] ?? message;
		updatesBuffer = [];
		updatesDirty = false;
		return current;
	}

	/** Close the current turn; the next frame opens a fresh message. Any
	 * text still buffered belongs to the closing message, so it lands here
	 * before the switch; the RAF timer above carries updates either way. */
	function closeTurn() {
		if (current && buffer.length > 0) {
			current.content += buffer;
			buffer = "";
		}
		if (current && updatesDirty) {
			current.updates = updatesBuffer;
			updatesDirty = false;
		}
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
	 * Adopt the running turn. Three shapes, one rule each:
	 *
	 * - mid-run mount: the trailing assistant IS the running turn's, so its
	 *   remaining deltas continue into it rather than splitting the bubble;
	 * - after a user echo (the mount's replay order): a fresh empty bubble
	 *   carries the generating indicator until the first token lands;
	 * - running BEFORE any user echo (the daemon's live order — turn_started
	 *   precedes the timeline echo): nothing is adopted or created, because
	 *   an empty assistant ABOVE the not-yet-arrived user message is a
	 *   bubble stranded at the transcript head. The echo and the tokens open
	 *   the turn's bubble in the right place.
	 */
	function adoptRunning(): Message | null {
		if (current) return current;
		const last = messages.at(-1);
		if (last && last.from === "assistant") {
			current = last;
			updatesBuffer = [...(last.updates ?? [])];
			updatesDirty = false;
			return last;
		}
		if (messages.some((message) => message.from === "user")) {
			return openAssistant();
		}
		return null;
	}

	/** Attach an update to a message that may not be the buffered one. */
	function attach(target: Message, update: MessageUpdate) {
		if (target === current) {
			pushUpdate(update);
			scheduleFrameFlush();
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
			case "reset": {
				// The machine's process restarted (a new epoch): every id
				// before this point is gone, so the whole transcript is
				// discarded and rebuilt from what follows — a plain clear,
				// not a close, since the same iterator keeps yielding.
				messages.length = 0;
				current = null;
				buffer = "";
				updatesBuffer = [];
				updatesDirty = false;
				toolOpen.clear();
				toolClosed.clear();
				ctx.onTurnEvent();
				ctx.onReset?.();
				break;
			}
			case "user": {
				closeTurn();
				// The one property a user frame adds: its attachments, which
				// ChatMessage already renders on a user message.
				messages.push({
					id: v4(),
					from: "user",
					content: update.text,
					children: [],
					...(update.files?.length ? { files: update.files } : {}),
				});
				break;
			}
			// Side channel (M3): never opens/closes a turn, never touches
			// current/buffer/updatesBuffer — the latest value simply replaces
			// whatever the view is holding, so a replayed history re-delivering
			// these in order is correct without any de-duplication.
			case "usage": {
				ctx.onUsage?.(update.usage);
				break;
			}
			case "compaction": {
				ctx.onCompaction?.(update);
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
				openAssistant();
				if (update.subtype === MessageToolUpdateType.Call) {
					if (toolOpen.has(update.uuid)) break;
					toolOpen.add(update.uuid);
					pushUpdate(update);
					scheduleFrameFlush();
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
				scheduleFrameFlush();
				break;
			}
			case MessageUpdateType.Plan: {
				openAssistant();
				pushUpdate(update);
				scheduleFrameFlush();
				break;
			}
			case MessageUpdateType.Elicitation: {
				if (update.subtype === MessageElicitationUpdateType.Request) {
					openAssistant();
					pushUpdate(update);
					scheduleFrameFlush();
					break;
				}
				// A resolution settles the card that asked, wherever it lives —
				// the transcript, not the open turn, owns the pairing. The open
				// turn's pending request may still be in the uncommitted buffer,
				// so it is matched there too; a same-batch resolution never
				// misses its request.
				const bufferedRequest =
					current &&
					updatesBuffer.some(
						(candidate) =>
							candidate.type === MessageUpdateType.Elicitation &&
							candidate.subtype === MessageElicitationUpdateType.Request &&
							candidate.request.elicitationId === update.elicitationId
					);
				const target = bufferedRequest
					? current
					: [...messages]
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
				ctx.onTurnEvent();
				if (update.state === "running") {
					const adopted = adoptRunning();
					if (!adopted) break; // running before the echo: nothing to carry it
					pushUpdate(update);
					scheduleFrameFlush();
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
