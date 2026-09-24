import type {
	ElicitationField,
	ElicitationRequestPayload,
	ElicitationValue,
} from "$lib/types/McpElicitation";

const HEAD_MAX = 48;
const ANSWER_MAX = 64;

const clip = (text: string, max: number) =>
	text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

/**
 * The one-line summary an answered question collapses to: "<header or short
 * question> → <choice(s)>". Only for the assistant's own questions (chat's
 * ask_user_question and an agent's question tool, both `source: "assistant"`);
 * an MCP server's elicitation keeps showing which server asked. Built from the
 * stored answer, so it reads the same after a reload.
 */
export function questionSummary(
	request: Pick<ElicitationRequestPayload, "source" | "message" | "fields">,
	answered: Record<string, ElicitationValue> | undefined
): string | null {
	if (request.source !== "assistant") return null;
	const fields = request.fields ?? [];
	const first = fields[0];
	const head = clip(
		(first?.title || first?.description || request.message || "").trim() || "Question",
		HEAD_MAX
	);
	if (!answered) return head;
	const answers = fields
		.map((field) => answerText(field, answered[field.name]))
		.filter((text): text is string => Boolean(text));
	return answers.length ? `${head} → ${clip(answers.join(" · "), ANSWER_MAX)}` : head;
}

function answerText(field: ElicitationField, value: ElicitationValue | undefined): string | null {
	if (value === undefined || value === "") return null;
	const values = Array.isArray(value) ? value : [value];
	if (field.kind !== "select") return values.map(String).join(", ");
	const labels = values.map((v) => {
		const option = field.options.find((o) => o.value === String(v));
		return option ? option.label : `Other: ${String(v)}`;
	});
	return labels.join(", ");
}
