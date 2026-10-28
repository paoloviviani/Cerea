/**
 * The Office and PDF skills carry exactly one rule (ADR 0103): when the doc_*
 * tools are offered they are the ONLY way to create or edit a document, and the
 * in-sandbox method lives in a labelled fallback section that nothing above it
 * mentions. A skill that tells a model both ways is a skill that gets Python
 * written for documents the tools could have made, so the wording is pinned.
 */
import { describe, expect, it } from "vitest";
import { listBuiltinSkills } from "./builtinSkills";

const OFFICE = ["word", "excel", "powerpoint", "pdf"] as const;
const FALLBACK = "## Fallback: only when the doc_* tools are not available";
/** PowerPoint alone has a second case: the person's explicit custom-design request. */
const PPTX_FALLBACK = "## Fallback: when the doc_* tools are not available, or for a custom design";
const fallbackOf = (name: string) => (name === "powerpoint" ? PPTX_FALLBACK : FALLBACK);
/** Names that mean "write Python for the document": only the fallback may use them. */
const SANDBOX_WAYS =
	/micropip|load_skill_file|execute_code|python-docx|python-pptx|openpyxl|reportlab|pypdf|xlsx_patch|docx_edit|docx_tables|docx_verify|pptx_edit|pptx_slides|pptx_verify|generate\.py|validate\.py|edit\.py|import docx|import openpyxl|DataFrame\.to_excel/;

function skill(name: string) {
	const found = listBuiltinSkills().find((s) => s.name === name);
	if (!found) throw new Error(`no built-in skill ${name}`);
	return found;
}

function parts(name: string) {
	const content = skill(name).content;
	const at = content.indexOf(fallbackOf(name));
	return {
		content,
		at,
		toolsFirst: at < 0 ? content : content.slice(0, at),
		fallback: at < 0 ? "" : content.slice(at),
	};
}

/** The text of one `## ` section. */
function section(content: string, heading: string): string {
	const start = content.indexOf(`\n## ${heading}\n`);
	if (start < 0) throw new Error(`no section ${heading}`);
	const next = content.indexOf("\n## ", start + 1);
	return content.slice(start, next < 0 ? undefined : next);
}

describe.each(OFFICE)("the %s skill", (name) => {
	it("states the one rule first: the doc_* tools are the ONLY way when they are offered", () => {
		const { toolsFirst } = parts(name);
		const rule = section(toolsFirst, "One rule");
		expect(rule).toMatch(/When `doc_create` is in your tool list/);
		expect(rule).toContain("ONLY way");
		expect(rule).toMatch(/Do not\s+write Python/);
		expect(rule).toMatch(/do not\s+mix the two ways|do not make a Word file only to convert/);
		expect(rule).toMatch(/jump to the last\s+section,\s+"Fallback"/);
		// the rule comes before any other guidance
		const headings = toolsFirst.match(/^## .+$/gm) ?? [];
		expect(headings[0]).toBe("## One rule");
	});

	it("has exactly one fallback section, labelled, and it is the last", () => {
		const { content, fallback } = parts(name);
		const heading = fallbackOf(name);
		expect(content.split(heading)).toHaveLength(2);
		expect(fallback.startsWith(heading)).toBe(true);
		expect(fallback).toContain("Read this section only if `doc_create` is NOT in your tool list");
		expect(fallback).toMatch(/must not be mixed with the\s+tools/);
		// nothing after the fallback heading is a second-level section of its own
		expect(fallback.slice(FALLBACK.length)).not.toMatch(/^## /m);
	});

	it("names no way of writing documents in Python outside the fallback, except to forbid it", () => {
		const { toolsFirst } = parts(name);
		const withoutRule = toolsFirst.replace(section(toolsFirst, "One rule"), "");
		// the frontmatter description is read in skill lists: it must not advertise a library either
		const description = skill(name).description;
		expect(description, "description").not.toMatch(SANDBOX_WAYS);
		expect(description).toMatch(/doc_|tool/);
		const hits = withoutRule.match(new RegExp(SANDBOX_WAYS.source, "g")) ?? [];
		expect(hits, `${name}: sandbox ways named above the fallback`).toEqual([]);
	});

	it("keeps the fallback's helper scripts bundled, so deployments without the service still work", () => {
		const { fallback } = parts(name);
		expect(fallback.length).toBeGreaterThan(800);
		expect(fallback).toMatch(/micropip|load_skill_file|reportlab/);
	});

	it("never tells the model to choose between the two ways", () => {
		const { content } = parts(name);
		expect(content).not.toMatch(/First choice/i);
		expect(content).not.toMatch(/or the helpers above/);
		expect(content).not.toMatch(/use the helpers below/);
	});
});

describe("the powerpoint design exception", () => {
	it("is opt-in, announced in one line, and never mixed within a deck, above the fallback", () => {
		const { toolsFirst } = parts("powerpoint");
		const rule = section(toolsFirst, "One rule");
		expect(rule).toContain("ONLY way");
		expect(rule).toContain("explicitly asks");
		expect(rule).toMatch(/say in one line that you are building a custom design in\s+the sandbox/);
		expect(rule).toMatch(/never\s+mixed/);
		expect(rule).toMatch(/\bdoc_edit\b/);
		expect(rule).toMatch(/"make it nice" is not an opt-in/);
		// when unsure, ask first: with the question tool, else in plain text
		expect(rule).toMatch(/When it is unclear which the person wants/);
		expect(rule).toMatch(/ask before building\s+anything/);
		expect(rule).toContain("`ask_user_question`");
		expect(rule).toMatch(/clean deck in\s+standard layouts/);
		expect(rule).toMatch(/custom design with free shapes and backgrounds/);
		expect(rule).toMatch(/not in your tool list, ask the same in plain\s+text/);
		expect(rule).toMatch(/Clear cases need\s+no question/);
	});

	it("the fallback names both cases and carries the design guidance", () => {
		const { fallback } = parts("powerpoint");
		expect(fallback).toMatch(/or the design exception in "One rule"\s+applies/);
		expect(fallback).toContain("16:9");
		expect(fallback).toContain("validate.py");
		expect(fallback).toMatch(/at least 14 pt/);
		expect(fallback).toContain("/mnt/output/");
	});

	it("the other three skills keep the strict rule, with no exception", () => {
		for (const name of ["word", "excel", "pdf"]) {
			const { content, toolsFirst } = parts(name);
			expect(section(toolsFirst, "One rule"), name).not.toContain("explicitly asks");
			expect(content, name).toContain(FALLBACK);
		}
	});
});

describe("the pdf-tools skill and PDF forms", () => {
	const FORMS_FALLBACK = "## Fallback: forms in the sandbox";
	const content = skill("pdf-tools").content;
	const at = content.indexOf(FORMS_FALLBACK);
	const toolsFirst = content.slice(0, at);
	const fallback = content.slice(at);
	/** The helper's form functions and what they return: only the fallback may name them. */
	const HELPER_FORMS = /form_fields|fill_form\(|pdf_tools\.fill_form|PdfFormError/;

	it("states one rule for forms first: doc_outline and doc_edit when they are offered", () => {
		expect(at).toBeGreaterThan(0);
		expect(content.split(FORMS_FALLBACK)).toHaveLength(2);
		const rule = section(toolsFirst, "One rule for forms");
		expect(rule).toMatch(
			/When `doc_edit` is in your tool list, a PDF form is filled ONLY with\s+`doc_outline` and `doc_edit`/
		);
		expect(rule).toMatch(/Do not fill a form in the sandbox/);
		expect(rule).toMatch(/jump to the last section, "Fallback: forms in the sandbox"/);
		const headings = toolsFirst.match(/^## .+$/gm) ?? [];
		expect(headings[0]).toBe("## One rule for forms");
	});

	it("tells the model to list the fields first, ask about anything ambiguous and report what was filled", () => {
		const rule = section(toolsFirst, "One rule for forms");
		expect(rule).toMatch(/Always call it first/);
		expect(rule).toMatch(/never\s+guess a field name/);
		expect(rule).toMatch(/ambiguous[^]*ask the user/);
		expect(rule).toMatch(/Report what was filled/);
		expect(rule).toMatch(/not_taken/);
		expect(rule).toMatch(/\*\*XFA\*\*/);
		expect(rule).toMatch(/\*\*no\s+form fields\*\*/);
		expect(rule).toMatch(/\*\*signed\*\*[^]*invalidate the digital signature/);
		expect(rule).toMatch(/required_missing/);
	});

	it("names the helper's form functions only in the fallback, which is the last section", () => {
		expect(toolsFirst.replace(section(toolsFirst, "One rule for forms"), "")).not.toMatch(
			HELPER_FORMS
		);
		expect(fallback.slice(FORMS_FALLBACK.length)).not.toMatch(/^## /m);
		expect(fallback).toContain("Read this section only if `doc_edit` is NOT in your tool list");
		expect(fallback).toMatch(/must not be mixed with the\s+tools/);
		expect(fallback).toMatch(HELPER_FORMS);
		expect(fallback).toMatch(/XFA/);
	});

	it("uses the users, not the people", () => {
		expect(content).not.toMatch(/\bpeople\b/i);
	});
});

describe("pairs with the rest of the skills", () => {
	it("the pdf skill sends existing-PDF work to pdf-tools, which stays a sandbox skill", () => {
		const { toolsFirst } = parts("pdf");
		expect(toolsFirst).toContain("`pdf-tools`");
		expect(toolsFirst).toMatch(
			/only `doc_outline` and `doc_edit fill_form` work\s+on an existing PDF/
		);
		expect(toolsFirst).toMatch(/do not edit a PDF in any other way/);
		const tools = skill("pdf-tools").content;
		expect(tools).toContain("pypdf");
		expect(tools).toMatch(/For \*\*creating\*\* a new PDF, use the `pdf`\s+skill instead/);
	});

	it("a chart for a document goes through the tool's chart block or a picture passed by name", () => {
		for (const name of ["word", "excel", "powerpoint"]) {
			const { toolsFirst } = parts(name);
			expect(toolsFirst, name).toMatch(/render[`:\s]+"native"/);
			expect(toolsFirst, name).toMatch(/\/mnt\/output\//);
			expect(toolsFirst, name).toMatch(/image reference|images/);
		}
	});

	it("the themes skill applies a theme through the tool's spec when the tools are offered", () => {
		const content = skill("themes").content;
		expect(content).toContain("`spec.theme`");
		expect(content).toMatch(/Only when the\s+document tools are NOT in your tool list/);
	});

	it("the tools are described as doing everything the old helpers did", () => {
		const word = parts("word").toolsFirst;
		expect(word).toContain("`doc_edit`");
		expect(word).toContain("track_changes");
		expect(word).toContain("doc_create_from_template");
		const excel = parts("excel").toolsFirst;
		expect(excel).toMatch(/never evaluates them/);
		expect(excel).toContain("Analysing the data");
		const deck = parts("powerpoint").toolsFirst;
		expect(deck).toContain("Core principle");
		expect(deck).toContain("two_content");
	});
});
