import { writable, derived } from "svelte/store";
import type { ElicitationRequestPayload } from "$lib/types/McpElicitation";

export interface PendingQuestion {
	conversationId: string;
	request: ElicitationRequestPayload;
}

/**
 * A list rather than one slot: a later turn can ask while an earlier question is still
 * open, and one slot would let the newer hide the older, which could then never be answered.
 */
const questions = writable<PendingQuestion[]>([]);

export function registerQuestion(conversationId: string, request: ElicitationRequestPayload) {
	questions.update((current) =>
		current.some((q) => q.request.elicitationId === request.elicitationId)
			? current
			: [...current, { conversationId, request }]
	);
}

export function unregisterQuestion(elicitationId: string) {
	questions.update((current) => current.filter((q) => q.request.elicitationId !== elicitationId));
}

export const pendingQuestions = derived(questions, ($questions) => $questions);

export const firstQuestionFor = (conversationId: string | undefined) =>
	derived(questions, ($questions) =>
		conversationId ? ($questions.find((q) => q.conversationId === conversationId) ?? null) : null
	);

/**
 * What a person has picked or typed on a question, kept by question id. The card is
 * drawn from the store above, and a re-render of the message that owns the question
 * can drop and re-add it, which remounts the card; without this the pick would reset
 * to "Pick an option to continue". Cleared once the question is answered.
 */
export interface QuestionDraft {
	step: number;
	picks: Record<string, string[]>;
	otherText: Record<string, string>;
	showOther: Record<string, boolean>;
}

const drafts = new Map<string, QuestionDraft>();

export const questionDraft = (elicitationId: string) => drafts.get(elicitationId);
export const saveQuestionDraft = (elicitationId: string, draft: QuestionDraft) =>
	void drafts.set(elicitationId, draft);
export const clearQuestionDraft = (elicitationId: string) => void drafts.delete(elicitationId);
