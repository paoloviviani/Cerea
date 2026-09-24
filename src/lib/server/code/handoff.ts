/**
 * The fork handoff's "chat history" attachment (parity plan §4.2(a); the
 * paseo mechanics it names — `buildAgentForkContext`, idempotency keys,
 * `cerea.handoff-from` labels — are obsolete, replaced by an ordinary
 * `session.create` + `session.prompt` pair over the thin machine protocol,
 * spec §6/§8).
 *
 * A curated markdown render of a source session's transcript: user and
 * assistant text, plus one line per tool call. No raw tool input/output
 * dumps and no synthetic parts — a fork context is meant to brief a fresh
 * agent, not replay the whole wire.
 */

import type { Message, Part, Transcript } from "$lib/types/machineProtocol";

/** The wire's own cap on the carried history (spec §4.2(a) security note):
 * the whole curated transcript already passes through Cerea, so this is a
 * size limit, not a new exposure. */
export const HANDOFF_HISTORY_CHAR_CAP = 200_000;

const TRUNCATION_NOTE = "\n\n*(chat history truncated at 200,000 characters)*";

export interface HandoffHistory {
	markdown: string;
	truncated: boolean;
}

/**
 * Renders `transcript` as markdown, stopping after `uptoMessageId` when
 * given (the "Carry the conversation up to here" boundary). Caps the result
 * at `HANDOFF_HISTORY_CHAR_CAP` characters, appending a note inside the text
 * itself when it does — the receiving agent has no other way to know its
 * briefing was cut short.
 */
export function buildHandoffHistory(
	transcript: Transcript,
	uptoMessageId?: string
): HandoffHistory {
	const sections: string[] = [];
	// The boundary names the bubble the person clicked, which the panel folds
	// from a whole turn: opencode writes one assistant message per step, and
	// the bubble carries the first one's id. So "up to here" means through the
	// end of that turn, i.e. until the next user message.
	let reachedBoundary = false;
	for (const { message, parts } of transcript.messages ?? []) {
		if (reachedBoundary && message.role === "user") break;
		const rendered = renderMessage(message, parts ?? []);
		if (rendered) sections.push(rendered);
		if (uptoMessageId && message.id === uptoMessageId) reachedBoundary = true;
	}
	const full = sections.join("\n\n");
	if (full.length <= HANDOFF_HISTORY_CHAR_CAP) {
		return { markdown: full, truncated: false };
	}
	const cut = full.slice(0, HANDOFF_HISTORY_CHAR_CAP - TRUNCATION_NOTE.length);
	return { markdown: cut + TRUNCATION_NOTE, truncated: true };
}

function renderMessage(message: Message, parts: Part[]): string | null {
	const lines: string[] = [];
	for (const part of parts) {
		if (part.type === "text") {
			if (part.synthetic || !part.text) continue;
			lines.push(part.text);
		} else if (part.type === "tool") {
			lines.push(toolLine(part));
		}
	}
	if (!lines.length) return null;
	const heading = message.role === "user" ? "**User:**" : "**Assistant:**";
	return `${heading}\n${lines.join("\n")}`;
}

function toolLine(part: Extract<Part, { type: "tool" }>): string {
	const input = summarize(JSON.stringify(part.input ?? {}));
	const outcome =
		part.status === "error"
			? `error: ${summarize(part.error ?? "failed")}`
			: part.output
				? summarize(part.output)
				: "(no output)";
	return `- \`${part.tool}\`(${input}) → ${outcome}`;
}

function summarize(text: string, max = 160): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
