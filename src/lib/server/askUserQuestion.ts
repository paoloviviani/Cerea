import { randomUUID } from "crypto";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import type { ElicitationField, ElicitationRequestPayload } from "$lib/types/McpElicitation";
import type { ElicitationSink } from "$lib/server/mcp/elicitation";
import { MessageElicitationUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";

import { isCatchAllLabel } from "$lib/utils/questionOptions";

// The cards read the same rule, so an option the model offered as its own
// "Something else" replaces the form's built-in one instead of doubling it.
export { isCatchAllLabel };

const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 4;
const MIN_OPTIONS = 2;
const MAX_HEADER_CHARS = 12;

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

/** The tool as the model sees it. */
export const askUserQuestionTool = {
	type: "function" as const,
	function: {
		name: ASK_USER_QUESTION_TOOL_NAME,
		description:
			"Put a decision to the user as options they can click, and wait for the answer. " +
			"Use it only when you are blocked on a real choice: the request has more than one sensible reading and those readings " +
			"lead to materially different work (which framing, which scope, which of several approaches). " +
			"Not for something you can look up, a choice with an obvious default, or anything the user has already told you. " +
			'Never use it to confirm, verify or ask "did it work?" / "is this what you wanted?": deliver, and let the user reply in chat. ' +
			"Never call it in the same step as delivering content (an artifact, code, a long answer): write the content out in your reply first; " +
			"a question in place of the content means the user never sees it. " +
			`Ask 1-${MAX_QUESTIONS} questions in one call, each with ${MIN_OPTIONS}-${MAX_OPTIONS} options; ` +
			"set multiSelect when the user may pick more than one. " +
			'The user can ALWAYS choose "Other" and type their own answer instead: the interface adds that choice automatically, ' +
			'so never add an "Other", "Something else" or catch-all option yourself. ' +
			"The result says, for each question, which option(s) were chosen or the text the user typed.",
		parameters: {
			type: "object",
			properties: {
				questions: {
					type: "array",
					minItems: 1,
					maxItems: MAX_QUESTIONS,
					description: `The decisions to put to the user, 1 to ${MAX_QUESTIONS}.`,
					items: {
						type: "object",
						properties: {
							question: {
								type: "string",
								description: "The complete question, ending in a question mark.",
							},
							header: {
								type: "string",
								description: `A short chip label for the question, at most ${MAX_HEADER_CHARS} characters (e.g. "Format").`,
							},
							multiSelect: {
								type: "boolean",
								description: "true lets the user pick several options; false means exactly one.",
							},
							options: {
								type: "array",
								minItems: MIN_OPTIONS,
								maxItems: MAX_OPTIONS,
								description: `${MIN_OPTIONS}-${MAX_OPTIONS} concrete choices. Do not include an "Other" option: it is added for you.`,
								items: {
									type: "object",
									properties: {
										label: { type: "string", description: "The choice, in a few words." },
										description: {
											type: "string",
											description:
												"Shown under the label: what picking this means, its consequence or trade-off, in one line.",
										},
									},
									required: ["label", "description"],
								},
							},
						},
						required: ["question", "header", "options", "multiSelect"],
					},
				},
			},
			required: ["questions"],
		},
	},
};

const asText = (value: unknown, max: number): string | undefined => {
	if (typeof value !== "string") return undefined;
	// Model-authored, so the same display rules as server-authored text apply.
	const cleaned = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
	if (!cleaned) return undefined;
	return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
};

export type NormalizedAsk =
	| { ok: true; payload: Omit<ElicitationRequestPayload, "elicitationId"> }
	| { ok: false; reason: string };

/**
 * Each question becomes one select field, so the form, its validation and the settled
 * transcript row are the ones elicitation already uses.
 */
export function normalizeAskUserQuestion(args: unknown): NormalizedAsk {
	const questions = (args as { questions?: unknown } | null)?.questions;
	if (!Array.isArray(questions) || questions.length === 0) {
		return { ok: false, reason: "no questions were given" };
	}
	if (questions.length > MAX_QUESTIONS) {
		return { ok: false, reason: `too many questions (${questions.length})` };
	}

	const fields: ElicitationField[] = [];
	for (const [index, raw] of questions.entries()) {
		const q = raw as Record<string, unknown> | null;
		const question = asText(q?.question, 300);
		if (!question) return { ok: false, reason: `question ${index + 1} has no text` };

		const options: Array<{ value: string; label: string; description?: string }> = [];
		const rawOptions = Array.isArray(q?.options) ? q.options : [];
		for (const rawOption of rawOptions) {
			const option = rawOption as Record<string, unknown>;
			const label = asText(option?.label, 80);
			// Keyed by value in the form, so a repeat would break rendering outright.
			if (!label || options.some((o) => o.value === label)) continue;
			const description = asText(option?.description, 200);
			options.push({ value: label, label, ...(description ? { description } : {}) });
		}
		// The form always adds its own "Other", so a model-authored one would show
		// twice. Drop it when enough real options remain; otherwise keep the
		// model's and suppress the form's instead.
		const catchAll = options.filter((o) => isCatchAllLabel(o.label));
		let allowOther = true;
		if (catchAll.length > 0) {
			if (options.length - catchAll.length >= MIN_OPTIONS) {
				for (const o of catchAll) options.splice(options.indexOf(o), 1);
			} else {
				allowOther = false;
			}
		}
		if (options.length < MIN_OPTIONS) {
			return { ok: false, reason: `question ${index + 1} needs at least ${MIN_OPTIONS} options` };
		}
		if (options.length > MAX_OPTIONS) options.length = MAX_OPTIONS;

		fields.push({
			kind: "select",
			// Answers come back keyed by this, so it has to survive a JSON round trip.
			name: `q${index + 1}`,
			title: asText(q?.header, MAX_HEADER_CHARS) ?? question,
			description: question,
			required: true,
			multiple: q?.multiSelect === true,
			options,
			// The model's options are guesses; the user always keeps a way to say otherwise.
			allowOther,
			...(q?.multiSelect === true ? { minItems: 1 } : {}),
		});
	}

	return {
		ok: true,
		payload: {
			source: "assistant",
			server: "",
			mode: "form",
			message: fields.length === 1 ? (fields[0].description ?? "") : "A few things to decide.",
			fields,
		},
	};
}

export function answerToToolResult(
	payload: ElicitationRequestPayload,
	action: "accept" | "decline" | "cancel",
	content?: Record<string, unknown>
): string {
	if (action !== "accept" || !content) {
		return action === "decline"
			? "The user declined to answer. Proceed with your best judgement and say what you assumed."
			: "The user dismissed the question. Proceed with your best judgement and say what you assumed.";
	}
	// Each answer says whether it is one of the model's options or text the user
	// typed instead, so the model never mistakes a custom answer for a label.
	const answered = (payload.fields ?? []).map((field) => {
		const value = content[field.name];
		const values = (Array.isArray(value) ? value : [value])
			.map((v) => (typeof v === "string" ? v : v === undefined || v === null ? "" : String(v)))
			.filter((v) => v !== "");
		const known = field.kind === "select" ? field.options.map((o) => o.value) : [];
		const chosen = values.filter((v) => known.includes(v));
		const typed = values.filter((v) => !known.includes(v));
		const parts: string[] = [];
		if (chosen.length) parts.push(`chose ${chosen.map((v) => JSON.stringify(v)).join(", ")}`);
		if (typed.length) {
			parts.push(
				`${field.kind === "select" ? "typed their own answer (custom, not one of your options)" : "wrote"} ${typed
					.map((v) => JSON.stringify(v))
					.join(", ")}`
			);
		}
		const question = field.description ?? field.title ?? field.name;
		return `Q: ${question}\nA: ${parts.length ? parts.join("; ") : "(no answer)"}`;
	});
	return `The user answered:\n\n${answered.join("\n\n")}`;
}

/** Returns without waiting: nothing holds the run open, so the answer arrives later. */
export async function openAskPrompt({
	sink,
	toolUuid,
	toolCallId,
	messageId,
	args,
}: {
	sink: ElicitationSink;
	toolUuid: string;
	toolCallId: string;
	messageId: string;
	args: unknown;
}): Promise<{ opened: boolean; reason?: string }> {
	const normalized = normalizeAskUserQuestion(args);
	if (!normalized.ok) return { opened: false, reason: normalized.reason };

	const elicitationId = randomUUID();
	const request: ElicitationRequestPayload = { ...normalized.payload, elicitationId };
	const now = new Date();

	try {
		await collections.mcpElicitations.insertOne({
			_id: new ObjectId(),
			elicitationId,
			conversationId: sink.conversationId,
			...(sink.generationId ? { generationId: sink.generationId } : {}),
			status: "pending",
			request,
			pending: { kind: "ask", messageId, toolCallId, toolUuid },
			createdAt: now,
			updatedAt: now,
		});
	} catch (err) {
		logger.error({ err }, "[ask] failed to record question");
		return { opened: false, reason: "could not be recorded" };
	}

	sink.emit({
		type: MessageUpdateType.Elicitation,
		subtype: MessageElicitationUpdateType.Request,
		request,
		toolUuid,
	});
	return { opened: true };
}
