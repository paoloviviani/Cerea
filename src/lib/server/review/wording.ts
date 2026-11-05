/** The words on cards, in pushes and in the log (ADR 0107): one place, so they never drift. */

const pct = (p: number) => Math.round(p * 100);

export const allowedNote = (model: string, p: number) => `Auto-allowed by ${model} (${pct(p)}%)`;
export const belowNote = (p: number, threshold: number) =>
	`The reviewer wasn't sure enough (${pct(p)}%; it allows at ${pct(threshold)}%)`;
export const ruleNote = (reason: string) => `This kind of request always comes to you: ${reason}`;
export const unavailableNote = () => "The reviewer couldn't be reached, so this comes to you";
export const refusedNote = () => "The reviewer declined to judge this, so it comes to you";
export const cappedNote = () =>
	"The reviewer has reached its hourly limit for this machine, so this comes to you";
export const noAccessNote = () =>
	"The reviewer needs your background access, which is missing, so this comes to you";

/** The note a card shows for one ask, kept until the process restarts (bounded). */
export interface ReviewNote {
	text: string;
	/** True when the reviewer allowed it; false when it was sent to the user. */
	allowed: boolean;
}
const notes = new Map<string, ReviewNote>();
const MAX_NOTES = 2000;

const listeners = new Set<(requestId: string, note: ReviewNote) => void>();

/** Called whenever a note is set: a card already on screen learns why the ask came to the user. */
export function onReviewNote(fn: (requestId: string, note: ReviewNote) => void): () => void {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function setReviewNote(requestId: string, note: ReviewNote): void {
	notes.delete(requestId);
	notes.set(requestId, note);
	for (const fn of listeners) {
		try {
			fn(requestId, note);
		} catch {
			// a listener must never break the review
		}
	}
	if (notes.size > MAX_NOTES) {
		for (const k of notes.keys()) {
			if (notes.size <= MAX_NOTES / 2) break;
			notes.delete(k);
		}
	}
}
export function clearReviewNote(requestId: string): void {
	notes.delete(requestId);
}
export function reviewNoteFor(requestId: string): ReviewNote | undefined {
	return notes.get(requestId);
}
