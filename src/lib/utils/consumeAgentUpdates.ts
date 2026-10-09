import { v4 } from "uuid";
import {
	MessageElicitationUpdateType,
	MessageToolUpdateType,
	MessageUpdateType,
	type MessageBackgroundTaskUpdate,
	type MessageToolCallUpdate,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";
import type {
	AgentCompactionUpdate,
	AgentMessageBoundaryUpdate,
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
	/** A `childActivity` side-channel frame arrived: a subagent of this
	 * transcript did something its card may want to show. Never touches turn
	 * structure — the subagent card re-syncs the child's own timeline on it,
	 * throttled. */
	onChildActivity?: (childId: string) => void;
	/** The bridge's `historyDone` marker: the connection's history replay is
	 * fully folded and the live tail starts here. The view uses it to swap
	 * its loading state for the rendered transcript, landed at the bottom.
	 * Fires with the buffer committed, so the last message is whole; fires
	 * again on every SSE reconnect (the replay re-runs per connection). */
	onHistoryDone?: () => void;
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
	/** The machine's own id for the message about to open, from the last
	 * `messageBoundary` frame (spec §7's `message` event always precedes that
	 * message's own content, live and replayed alike) — consumed by whichever
	 * of `openAssistant`/the `user` case creates the next `Message`. */
	let pendingMessageId: string | undefined;
	/** Ids already given to a message of this transcript. opencode re-emits
	 * `message.updated` for a message it has already announced (twice for the
	 * first user message in the captured order), and a repeat must not become
	 * the pending id of whatever opens next. */
	const stampedIds = new Set<string>();
	/** Same, for the sender of a message another session wrote. */
	let pendingSentBy: AgentMessageBoundaryUpdate["sentBy"];
	/** A person's message arrived while the turn was open (a steer): opencode
	 * folds it into the NEXT step, so the assistant message that answers it
	 * follows with no fresh busy/idle pair. Set at the echo, cleared where
	 * the follow-up message takes over or the turn ends. */
	let steered = false;

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
	// until input stops landing, which reads as a freeze. So the buffer
	// commits on a RAF, with a timer fallback for hidden tabs, where RAF
	// never fires but the transcript must still advance.
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
			// RAF never fires in a hidden tab; the timer (a 48ms ceiling)
			// keeps the transcript advancing when nothing paints.
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
		const message: Message = {
			id: v4(),
			from: "assistant",
			content: buffer,
			children: [],
			...(pendingMessageId ? { machineMessageId: pendingMessageId } : {}),
		};
		if (pendingMessageId) stampedIds.add(pendingMessageId);
		pendingMessageId = undefined;
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

	function openMessage(): Message | null {
		return current;
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
			if (last.machineMessageId) stampedIds.add(last.machineMessageId);
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
				pendingMessageId = undefined;
				pendingSentBy = undefined;
				stampedIds.clear();
				steered = false;
				ctx.onTurnEvent();
				ctx.onReset?.();
				break;
			}
			case "user": {
				// `current` alone does not say so: a follow-up's `running` frame
				// can land before its echo and adopt the PREVIOUS turn's message,
				// which already carries its ending. A message that has ended a
				// turn is not one that is mid-step.
				const midStep =
					current !== null &&
					!updatesBuffer.some(
						(candidate) =>
							candidate.type === MessageUpdateType.TurnState && candidate.state !== "running"
					);
				if (current && midStep) {
					// A steer, not a new turn: the open assistant message keeps
					// receiving the step it is in the middle of (opencode does
					// not cut it short), so it stays open beneath the person's
					// message; the message that answers the steer takes over at
					// its own boundary.
					flushBuffer();
					steered = true;
				} else {
					closeTurn();
				}
				// The one property a user frame adds: its attachments, which
				// ChatMessage already renders on a user message. A slash
				// command's marker rides the same way (PROTOCOL.md §7): the
				// bubble renders "/name args" and the expanded text folds.
				messages.push({
					id: v4(),
					from: "user",
					content: update.text,
					children: [],
					...(pendingMessageId ? { machineMessageId: pendingMessageId } : {}),
					...(pendingSentBy ? { sentBy: pendingSentBy } : {}),
					...(update.files?.length ? { files: update.files } : {}),
					...(update.command ? { command: update.command } : {}),
				});
				if (pendingMessageId) stampedIds.add(pendingMessageId);
				pendingMessageId = undefined;
				pendingSentBy = undefined;
				break;
			}
			// A pure boundary marker (see `AgentMessageBoundaryUpdate`): never
			// opens/closes a turn itself, just names the id the very next
			// message (whichever case creates it) should carry.
			case "messageBoundary": {
				// Read through a function: the closures above assign `current`, which
				// this loop's flow analysis cannot see.
				if (stampedIds.has(update.messageId)) break; // a repeat of one already announced
				const open = openMessage();
				if (update.role === "assistant" && open && !open.machineMessageId && !steered) {
					// The live order is `busy` then the message event, so the bubble
					// `busy` adopted is already open when its own boundary arrives:
					// name it, or the seam below cannot tell it from its successor.
					open.machineMessageId = update.messageId;
					stampedIds.add(update.messageId);
					break;
				}
				pendingMessageId = update.messageId;
				pendingSentBy = update.role === "user" ? update.sentBy : undefined;
				if (
					steered &&
					open &&
					update.role === "assistant" &&
					open.machineMessageId !== update.messageId
				) {
					// The answer to the steer: settle the message that was
					// mid-step and open its successor, running, at once — the turn
					// continues there, and no frame between the two may read idle.
					closeTurn();
					attach(open, {
						type: MessageUpdateType.TurnState,
						state: "done",
						serverNow: Date.now(),
					});
					steered = false;
					openAssistant();
					pushUpdate({
						type: MessageUpdateType.TurnState,
						state: "running",
						serverNow: Date.now(),
					});
					scheduleFrameFlush();
				}
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
			// A subagent's own activity, kept out of this transcript by
			// design (see `machineTimeline`'s child branch): the subagent
			// card re-syncs the child's timeline on it, throttled, so its
			// output streams live.
			case "childActivity": {
				ctx.onChildActivity?.(update.childId);
				break;
			}
			// The bridge's own marker (never from a machine): the history
			// replay is done. Commit the buffer first so the caller reads a
			// whole transcript — the last frame before it can be a stream
			// token whose RAF flush has not run yet.
			case "historyDone": {
				flushBuffer();
				ctx.onHistoryDone?.();
				break;
			}
			case MessageUpdateType.Stream: {
				openAssistant();
				const last = updatesBuffer.at(-1);
				if (last?.type === MessageUpdateType.Stream && last.partId === update.partId) {
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
					if (toolOpen.has(update.uuid)) {
						// opencode emits a Call while the model is still streaming
						// the arguments — the `pending` state, with an empty input
						// — and again once they have arrived. Keeping only the
						// first froze the card's Input on `{}` until a reload. A
						// filled Call replaces the stored one in place (same
						// position, new object so the reactive swap is seen); an
						// empty one never overwrites a filled one.
						let index = -1;
						for (let i = updatesBuffer.length - 1; i >= 0; i -= 1) {
							const entry = updatesBuffer[i];
							if (
								entry.type === MessageUpdateType.Tool &&
								entry.subtype === MessageToolUpdateType.Call &&
								entry.uuid === update.uuid
							) {
								index = i;
								break;
							}
						}
						if (index !== -1 && Object.keys(update.call.parameters ?? {}).length > 0) {
							const stored = updatesBuffer[index] as MessageToolCallUpdate;
							updatesBuffer = [
								...updatesBuffer.slice(0, index),
								{ ...stored, call: update.call },
								...updatesBuffer.slice(index + 1),
							];
							updatesDirty = true;
							scheduleFrameFlush();
						}
						break;
					}
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
			case MessageUpdateType.BackgroundTask: {
				// A completion (or failure) for a child already marked running
				// folds into that marker in place — one marker per background
				// child, running then completed — wherever in the transcript the
				// running half landed, even when the synthetic result arrives a
				// turn later. Only a marker for an unknown child opens a fresh
				// row on this turn.
				if (update.state !== "running") {
					const isRunningMarker = (
						candidate: MessageUpdate
					): candidate is MessageBackgroundTaskUpdate =>
						candidate.type === MessageUpdateType.BackgroundTask &&
						(candidate as MessageBackgroundTaskUpdate).taskId === update.taskId &&
						(candidate as MessageBackgroundTaskUpdate).state === "running";
					const merge = (prev: MessageBackgroundTaskUpdate): MessageBackgroundTaskUpdate => ({
						...prev,
						state: update.state,
						summary: update.summary ?? prev.summary,
						text: update.text ?? prev.text,
						automatic: true,
					});
					const bufferedIndex = updatesBuffer.findIndex(isRunningMarker);
					if (current && bufferedIndex >= 0) {
						updatesBuffer = [
							...updatesBuffer.slice(0, bufferedIndex),
							merge(updatesBuffer[bufferedIndex] as MessageBackgroundTaskUpdate),
							...updatesBuffer.slice(bufferedIndex + 1),
						];
						updatesDirty = true;
						scheduleFrameFlush();
						break;
					}
					const target = [...messages]
						.reverse()
						.find(
							(message) =>
								message.from === "assistant" && (message.updates ?? []).some(isRunningMarker)
						);
					if (target) {
						const updates = target.updates ?? [];
						const index = updates.findIndex(isRunningMarker);
						target.updates = [
							...updates.slice(0, index),
							merge(updates[index] as MessageBackgroundTaskUpdate),
							...updates.slice(index + 1),
						];
						break;
					}
				}
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
				steered = false;
				break;
			}
			default:
				break;
		}
	}

	flushBuffer();
}
