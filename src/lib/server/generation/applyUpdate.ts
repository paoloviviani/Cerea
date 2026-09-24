import {
	MessageReasoningUpdateType,
	MessageUpdateStatus,
	MessageUpdateType,
	type MessageUpdate,
} from "$lib/types/MessageUpdate";
import type { Conversation } from "$lib/types/Conversation";
import type { Message } from "$lib/types/Message";
import { isMessageToolUpdate } from "$lib/utils/messageUpdates";
import { stripThink } from "$lib/utils/stripThink";

export interface ApplyUpdateContext {
	/** The assistant message this turn writes into. Mutated in place. */
	message: Message;
	/** Mutated in place for title only; persisting it is the caller's job. */
	conv: Pick<Conversation, "title">;
	/**
	 * Content the message already had when the turn began. A resumed turn continues
	 * a message that is not empty, and the final answer replaces only what this turn
	 * produced — not what an earlier round of the same message already said.
	 */
	initialContent: string;
	/** Router models record route+model; everything else records provider alone. */
	isRouterModel: boolean;
}

export interface AppliedUpdate {
	/** An empty stream token is not an event: the caller must drop it entirely. */
	skipped: boolean;
	/** `conv.title` changed and wants persisting. */
	titleChanged: boolean;
	finalAnswerReceived: boolean;
}

const SKIPPED: AppliedUpdate = { skipped: true, titleChanged: false, finalAnswerReceived: false };

const THINK_CLOSE = "</think>";

/**
 * Join two consecutive tool-loop steps' text with a paragraph break.
 *
 * Pure concatenation is what glued "…play with trails." to "That one's on me…"
 * with no separator, in the persisted message (which the Markdown export
 * reads) and in the streamed tokens the UI renders. Empty segments never earn
 * a break, and neither does a boundary that already has one — so streaming
 * stays incremental (the break rides on the next step's first token) and
 * breaks never double.
 */
export function joinStepText(existing: string, next: string): string {
	return existing + stepSeparator(existing, next) + next;
}

/** The break {@link joinStepText} inserts: `"\n\n"` or `""`. */
export function stepSeparator(existing: string, next: string): string {
	// Visible text is what counts: a step of pure `<think>` reasoning is an
	// empty segment, and so is a message that holds nothing but reasoning.
	if (stripThink(existing).trim().length === 0) return "";
	if (stripThink(next).trim().length === 0) return "";
	if (/\n\n$/.test(existing) || /^\n/.test(next)) return "";
	return "\n\n";
}

/**
 * Whether this stream token starts a new step's text: a tool update ran since
 * the last stream token that carried visible text. Pure-reasoning chunks
 * (`<think>` without visible text yet) are neither a segment nor a boundary —
 * they are skipped so a step that thinks before it speaks still gets its break
 * when the visible words arrive.
 */
export function startsNewStepSegment(updates: readonly MessageUpdate[] | undefined): boolean {
	if (!updates) return false;
	for (let i = updates.length - 1; i >= 0; i--) {
		const update = updates[i];
		if (update.type === MessageUpdateType.Stream) {
			if (update.token && stripThink(update.token).trim().length > 0) return false;
			continue;
		}
		if (isMessageToolUpdate(update)) return true;
	}
	return false;
}

/**
 * Fold one update into the message a turn is building.
 *
 * Extracted from the conversation route so a turn woken by the sweeper persists
 * the same way a turn driven by an HTTP request does. Two implementations of this
 * would drift, and drift here means messages that persist subtly wrong — the
 * pre-tool merge below is exactly the kind of hard-won rule that gets lost.
 *
 * Deliberately does no I/O: the title write, the generation writer, metrics, the
 * wire padding and the SSE enqueue all stay with their callers, because those
 * differ between an HTTP turn and a swept one.
 */
export function applyUpdateToMessage(
	event: MessageUpdate,
	{ message, conv, initialContent, isRouterModel }: ApplyUpdateContext
): AppliedUpdate {
	let titleChanged = false;
	let finalAnswerReceived = false;

	if (event.type === MessageUpdateType.Stream) {
		if (event.token === "") return SKIPPED;
		if (startsNewStepSegment(message.updates)) {
			// A step that opens with reasoning yields `<think>…</think>` ahead of
			// its visible words (sometimes in this very token): the break goes
			// after the think markup, not before it, or the UI renders it inside
			// the collapsed reasoning block where nobody sees it.
			const closeAt = event.token.lastIndexOf(THINK_CLOSE);
			const head = closeAt >= 0 ? event.token.slice(0, closeAt + THINK_CLOSE.length) : "";
			const tail = closeAt >= 0 ? event.token.slice(closeAt + THINK_CLOSE.length) : event.token;
			const gap = stepSeparator(message.content + head, tail);
			if (gap) {
				// Mutating the event (not just `message.content`) keeps every
				// downstream consumer consistent: the updates log the route
				// persists, the generation-event writer, and the SSE token the
				// client appends to its live view — UI and export read the same
				// bytes. Streaming stays incremental: nothing is buffered, the
				// break simply rides on the step's first visible token.
				event.token = head + gap + tail;
			}
		}
		message.content += event.token;
	} else if (
		event.type === MessageUpdateType.Reasoning &&
		event.subtype === MessageReasoningUpdateType.Stream &&
		"token" in event
	) {
		message.reasoning ??= "";
		message.reasoning += event.token;
	} else if (event.type === MessageUpdateType.Title) {
		// A reasoning model will put think markers in a title if nothing removes them.
		conv.title = event.title.replace(/<\/?think>/gi, "").trim();
		titleChanged = true;
	} else if (event.type === MessageUpdateType.FinalAnswer) {
		message.interrupted = event.interrupted;
		// Default behavior: replace the streamed text with the provider's final text.
		// However, when tools (MCP/function calls) were used, providers often stream
		// some content (e.g., a story) before triggering tools, then return a
		// different follow-up message afterwards (e.g., an image caption). Our
		// previous logic overwrote the pre-tool content. Preserve it by merging in
		// the pre-tool stream when tool updates occurred and the final text does
		// not already include the streamed prefix.
		const hadTools = (message.updates ?? []).some((u) => u.type === MessageUpdateType.Tool);

		if (hadTools) {
			const existing = message.content.slice(initialContent.length);
			if (existing && existing.length > 0) {
				// A. If we already streamed the same final text, keep as-is.
				if (event.text && existing.endsWith(event.text)) {
					message.content = initialContent + existing;
				}
				// B. If the final text already includes the streamed prefix, use it verbatim.
				else if (event.text && event.text.startsWith(existing)) {
					message.content = initialContent + event.text;
				}
				// C. Otherwise, merge with a paragraph break for readability.
				else {
					const needsGap = !/\n\n$/.test(existing) && !/^\n/.test(event.text ?? "");
					message.content =
						initialContent + existing + (needsGap ? "\n\n" : "") + (event.text ?? "");
				}
			} else {
				message.content = initialContent + (event.text ?? "");
			}
		} else {
			message.content = initialContent + event.text;
		}
		finalAnswerReceived = true;
	} else if (event.type === MessageUpdateType.File) {
		message.files = [
			...(message.files ?? []),
			{ type: "hash", name: event.name, value: event.sha, mime: event.mime },
		];
	} else if (event.type === MessageUpdateType.RouterMetadata) {
		// Merge metadata updates to preserve existing fields (router may send route/model
		// first, then provider comes later)
		if (isRouterModel) {
			message.routerMetadata = {
				route: event.route || message.routerMetadata?.route || "",
				model: event.model || message.routerMetadata?.model || "",
				provider: event.provider || message.routerMetadata?.provider,
			};
		} else if (event.provider) {
			message.routerMetadata = {
				route: message.routerMetadata?.route || "",
				model: message.routerMetadata?.model || "",
				provider: event.provider,
			};
		}
	}

	// Append updates for audit/replay (streams too, to preserve ordering)
	if (!(
		event.type === MessageUpdateType.Status && event.status === MessageUpdateStatus.KeepAlive
	)) {
		message.updates ??= [];
		message.updates.push(event.type === MessageUpdateType.Stream ? { ...event } : event);
	}

	message.updatedAt = new Date();

	return { skipped: false, titleChanged, finalAnswerReceived };
}
