/**
 * The chat's tool text is generated from what the service says in
 * `/v1/capabilities`. This reads a fixture of that answer (kept equal to the
 * real service by `documents/tests/test_api.py`, which fails when it is
 * stale) and checks every operation of every format reaches the tool, with
 * its required properties marked.
 *
 * Regenerate the fixture from `documents/`:
 *   uv run python -c "import json; from cerea_documents.core import capabilities; \
 *     print(json.dumps({**capabilities(), 'limits': {}}, indent='\t', sort_keys=True))" \
 *     > ../src/lib/server/documents/capabilities.fixture.json
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("$lib/server/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("$lib/server/config", () => ({ config: {} }));
vi.mock("$lib/server/database", () => ({ collections: {} }));
vi.mock("$lib/server/execution/deliverables", () => ({}));
vi.mock("$lib/server/files/downloadFile", () => ({}));

import fixture from "./capabilities.fixture.json";
const { createDocumentBuiltins } = await import("../textGeneration/builtinTools/documentTools");
const { DOCUMENT_FORMATS } = await import("./client");

describe("the service's contract reaches the edit tool", () => {
	const caps = fixture as unknown as Parameters<typeof createDocumentBuiltins>[0];
	const edit = createDocumentBuiltins(caps).find((t) => t.name === "doc_edit");
	const text = edit?.definition.function.description ?? "";

	it("names every operation of every format with its properties", () => {
		for (const format of DOCUMENT_FORMATS) {
			const entry = fixture.formats[format];
			for (const op of entry.operations) {
				const schema = (
					entry.operation_schemas as Record<string, { required: string[]; properties: object }>
				)[op];
				expect(text, `${format}.${op}`).toContain(`${op}{`);
				for (const key of Object.keys(schema.properties).filter((k) => k !== "op")) {
					expect(text, `${format}.${op}.${key}`).toContain(key);
				}
				for (const key of schema.required.filter((k) => k !== "op")) {
					expect(text, `${format}.${op}.${key} required`).toMatch(new RegExp(`[{ ]${key}: `));
				}
			}
		}
	});

	it("offers PDF forms and text: fill_form and place_text are the PDF's operations, and a PDF cannot be read", () => {
		expect(fixture.formats.pdf.operations).toEqual(["fill_form", "place_text"]);
		expect(fixture.formats.pdf.read).toBe(false);
		expect(text).toContain(
			"fill_form{flatten?: boolean, flatten_in_place?: boolean, values: object}"
		);
		expect(text).toMatch(/place_text\{allow_on_form\?: boolean, items: /);
		expect(text).toMatch(/A PDF has two operations, fill_form and place_text, and no other edit/);
	});

	it("keeps the tool description within its budget", () => {
		expect(text.length).toBeLessThan(3_000);
	});

	it("does not offer deferred operations", () => {
		for (const format of DOCUMENT_FORMATS) {
			for (const op of fixture.formats[format].deferred_operations) {
				expect(text).not.toContain(`${op}{`);
			}
		}
	});
});

describe("the service's contract reaches the create tool", () => {
	const caps = fixture as unknown as Parameters<typeof createDocumentBuiltins>[0];
	const create = createDocumentBuiltins(caps).find((t) => t.name === "doc_create");
	const text = create?.definition.function.description ?? "";
	const schemas = fixture.create_schemas as unknown as Record<
		string,
		{
			document: { properties: Record<string, unknown> };
			blocks: Record<string, { properties: Record<string, unknown> }>;
			sheet?: { properties: Record<string, unknown> };
			slide?: { properties: Record<string, unknown> };
		}
	>;

	it("is offered, with every format the service can create", () => {
		expect(create).toBeTruthy();
		for (const format of fixture.create_formats) {
			expect(text.toLowerCase(), format).toContain(`.${format})`);
		}
	});

	it("names every block, sheet and slide property of every format", () => {
		for (const [format, entry] of Object.entries(schemas)) {
			const parts = [
				...Object.entries(entry.blocks).map(([name, b]) => [`${format}.${name}`, name, b] as const),
				["sheet", "A sheet", entry.sheet] as const,
				["slide", "A slide", entry.slide] as const,
			];
			for (const [label, name, schema] of parts) {
				if (!schema) continue;
				if (name !== "A sheet" && name !== "A slide") expect(text, label).toContain(`${name}{`);
				for (const key of Object.keys(schema.properties).filter((k) => k !== "type")) {
					expect(text, `${label}.${key}`).toContain(key);
				}
			}
			for (const key of Object.keys(entry.document.properties)) {
				expect(text, `${format} spec.${key}`).toContain(key);
			}
		}
	});

	it("marks the properties a block cannot do without", () => {
		expect(text).toMatch(/heading\{level: integer/);
		expect(text).toMatch(/image\{[^}]*image: string/);
		expect(text).toMatch(/chart\{[^}]*chart_type: "bar"/);
		expect(text).toMatch(/chart\{[^}]*series: /);
		expect(text).toMatch(/sheet: \{[^]*name: string/);
	});
});
