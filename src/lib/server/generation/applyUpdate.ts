import {
	MessageReasoningUpdateType,
	MessageToolUpdateType,
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
 * A tool-loop step whose first visible words have not arrived yet: whether
 * the message is inside a `<think>` block right now, and any tag prefix a
 * token ended on ("<thi"), which only the next token can settle. Set when a
 * tool update passes, dropped once that step's answer starts. Kept beside the
 * message and advanced one token at a time, never recomputed from the whole
 * message: a step may reason for tens of thousands of tokens before it speaks,
 * and rescanning the content per token would make that quadratic. A message
 * object that outlives this map (a resumed turn) simply gets no break.
 */
interface PendingStep {
	inThink: boolean;
	carry: string;
}
const pendingSteps = new WeakMap<Message, PendingStep>();

const THINK_OPEN = "<think>";

/**
 * Advance `step` over `token`; the index in `token` where the step's first
 * visible (non-blank, outside `<think>`) character lands, or -1 while it is
 * still reasoning or blank. The same case-sensitive tags {@link stripThink}
 * recognises, so the two agree on what is visible.
 */
function firstVisibleIndex(step: PendingStep, token: string): number {
	const text = step.carry + token;
	const offset = step.carry.length;
	step.carry = "";
	let i = 0;
	while (i < text.length) {
		if (text[i] === "<") {
			const rest = text.slice(i, i + THINK_CLOSE.length);
			if (rest.startsWith(THINK_OPEN)) {
				step.inThink = true;
				i += THINK_OPEN.length;
				continue;
			}
			if (rest.startsWith(THINK_CLOSE)) {
				step.inThink = false;
				i += THINK_CLOSE.length;
				continue;
			}
			if (
				i + rest.length === text.length &&
				(THINK_OPEN.startsWith(rest) || THINK_CLOSE.startsWith(rest))
			) {
				step.carry = rest;
				return -1;
			}
		}
		if (!step.inThink && text[i].trim() !== "") return Math.max(0, i - offset);
		i++;
	}
	return -1;
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
		const step = pendingSteps.get(message);
		if (step) {
			// The break goes where the new step's answer starts: after any
			// reasoning it opens with (else the UI renders it inside the collapsed
			// reasoning block), never mid-reasoning, and only once.
			const at = firstVisibleIndex(step, event.token);
			if (at >= 0) {
				pendingSteps.delete(message);
				const head = event.token.slice(0, at);
				const tail = event.token.slice(at);
				const gap = stepSeparator(message.content + head, tail);
				// Mutating the event (not just `message.content`) keeps every
				// downstream consumer consistent: the updates log the route
				// persists, the generation-event writer, and the SSE token the
				// client appends to its live view. Nothing is buffered: the break
				// rides on the step's first visible token.
				if (gap) event.token = head + gap + tail;
			}
		}
		message.content += event.token;
	} else if (event.type === MessageUpdateType.ArtifactDraft) {
		// Ephemeral preview only: newer drafts replace older ones from the same
		// call (bounding what is persisted), and the transcript content is left
		// alone — the executed call's canonical block is what persists there.
		message.updates ??= [];
		const prev = message.updates.findIndex(
			(u) => u.type === MessageUpdateType.ArtifactDraft && u.toolCallId === event.toolCallId
		);
		if (prev !== -1) message.updates[prev] = event;
		else message.updates.push(event);
		message.updatedAt = new Date();
		return { skipped: false, titleChanged, finalAnswerReceived };
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
			// Whitespace-tolerant matching, mirroring the client's
			// mergeFinalAnswerContent (including its normForCompare: line
			// endings and Unicode normalization routinely differ between a
			// provider's streamed tokens and its final text while rendering
			// identically — byte comparison would duplicate the stored
			// message permanently). The two implementations must stay in
			// sync or views diverge.
			const norm = (text: string): string => text.replace(/\r\n/g, "\n").normalize("NFC");
			const normExisting = norm(existing);
			const normFinal = norm(event.text ?? "");
			const finalText = event.text ?? "";
			const trimmedExistingSuffix = normExisting.replace(/\s+$/, "");
			const trimmedFinalPrefix = normFinal.replace(/^\s+/, "");
			// Right-trimmed final for the trailing-junk case: a provider
			// final that is the streamed text plus a trailing newline (or
			// CRLF) must still count as streamed, or it falls through to
			// the paragraph-break join and the answer is stored twice,
			// permanently.
			const trimmedFinalSuffix = normFinal.replace(/\s+$/, "");
			const alreadyStreamed =
				!!finalText &&
				(normExisting.endsWith(normFinal) ||
					(trimmedFinalPrefix.length > 0 && trimmedExistingSuffix.endsWith(trimmedFinalPrefix)) ||
					(trimmedFinalSuffix.length > 0 && trimmedExistingSuffix.endsWith(trimmedFinalSuffix)));
			if (existing && existing.length > 0) {
				// A. If we already streamed the same final text, keep as-is.
				if (alreadyStreamed) {
					message.content = initialContent + existing;
				}
				// B. If the final text already includes the streamed prefix, use it verbatim.
				else if (
					finalText &&
					(normFinal.startsWith(normExisting) ||
						(trimmedExistingSuffix.length > 0 &&
							trimmedFinalPrefix.startsWith(trimmedExistingSuffix)))
				) {
					message.content = initialContent + finalText;
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

	// A draft previews a call still streaming its arguments; once any call's
	// result lands, or the turn ends, the executed calls' canonical blocks are
	// in the content, and a stored draft would only hold the same content a
	// second time.
	if (
		(event.type === MessageUpdateType.Tool &&
			(event.subtype === MessageToolUpdateType.Result ||
				event.subtype === MessageToolUpdateType.Error)) ||
		event.type === MessageUpdateType.FinalAnswer
	) {
		if (message.updates?.some((u) => u.type === MessageUpdateType.ArtifactDraft)) {
			message.updates = message.updates.filter((u) => u.type !== MessageUpdateType.ArtifactDraft);
		}
	}

	// A tool ran: whatever streams next starts a new step's text, which gets
	// a paragraph break from the previous step's once its visible words arrive.
	if (isMessageToolUpdate(event) && !pendingSteps.has(message)) {
		const content = message.content;
		pendingSteps.set(message, {
			inThink: content.lastIndexOf(THINK_OPEN) > content.lastIndexOf(THINK_CLOSE),
			carry: "",
		});
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
