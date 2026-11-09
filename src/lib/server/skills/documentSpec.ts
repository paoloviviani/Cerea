/**
 * The creation spec of a document format, delivered with that format's skill.
 *
 * `doc_create` carries only a short definition every turn; the full spec (blocks, sheets, slides, theme, cell
 * shapes) is generated from the document service's own schemas and appended to the text of the `word`, `excel`,
 * `powerpoint` and `pdf` skills when they are loaded (by `load_skill` or an `@name` mention). It is the same text
 * a `doc_create` rejection carries, so the two cannot disagree.
 */
import type { CreateFormat } from "$lib/server/documents/client";

const SKILL_FORMAT: Record<string, CreateFormat> = {
	word: "docx",
	excel: "xlsx",
	powerpoint: "pptx",
	pdf: "pdf",
};

/**
 * The section to append to a loaded skill's text; empty for any other skill, a user's own skill of the same
 * name, a deployment with no document service, or one that does not offer `doc_create`. Never throws.
 */
export async function documentSpecSection(
	skillName: string,
	owner: "user" | "admin"
): Promise<string> {
	const format = SKILL_FORMAT[skillName];
	if (!format || owner !== "admin") return "";
	try {
		const { getCapabilities } = await import("$lib/server/documents/client");
		const caps = await getCapabilities();
		if (!caps || caps.create !== true) return "";
		const { createFormatSpec, createToolText } =
			await import("$lib/server/textGeneration/builtinTools/documentTools");
		// exactly when `doc_create` is offered for this format (its list of formats, not just a schema)
		if (!createToolText(caps).formats.includes(format)) return "";
		return (
			`\n\n## The \`doc_create\` spec for ${format}\n\n` +
			'What the `spec` argument of `doc_create` takes for `format: "' +
			`${format}". Generated from the document service, \`?\` marks an optional property:\n\n` +
			createFormatSpec(caps, format)
		);
	} catch {
		return "";
	}
}

/**
 * A skill's body with the spec first: right after the description, before the guidance. A later turn replays a
 * tool result cut at 8,000 characters (`prepareFiles`), so the spec has to sit well inside that, not at the end.
 */
export function withDocumentSpec(body: string, spec: string): string {
	return spec ? `${spec.replace(/^\n+/, "")}\n\n${body}` : body;
}
