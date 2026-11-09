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
		if (!caps || caps.create !== true || !caps.create_schemas?.[format]) return "";
		const { createFormatSpec } =
			await import("$lib/server/textGeneration/builtinTools/documentTools");
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
 * A skill's body with the spec section before its "## Fallback" section (the in-sandbox method, which the
 * spec is not part of), or at the end when it has none.
 */
export function withDocumentSpec(body: string, spec: string): string {
	if (!spec) return body;
	const at = body.indexOf("\n## Fallback");
	return at < 0 ? body + spec : `${body.slice(0, at)}${spec}\n${body.slice(at)}`;
}
