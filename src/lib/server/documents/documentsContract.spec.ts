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

	it("does not offer deferred operations", () => {
		for (const format of DOCUMENT_FORMATS) {
			for (const op of fixture.formats[format].deferred_operations) {
				expect(text).not.toContain(`${op}{`);
			}
		}
	});
});
