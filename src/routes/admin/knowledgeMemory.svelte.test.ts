/** The admin Knowledge page keeps project chat memory visible, in its own category. */
import { afterEach, describe, expect, it, vi } from "vitest";

import Knowledge from "./knowledge/+page.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const row = (id: string, name: string, extra: object = {}) => ({
	id,
	name,
	description: "",
	owner_email: "ana@example.org",
	group_name: null,
	embedding_model: "embed-1",
	dimensions: 3,
	document_count: 2,
	chunk_count: 9,
	failed_count: 0,
	stale: false,
	share_count: 0,
	created_at: "2026-01-01T00:00:00Z",
	...extra,
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("admin Knowledge page", () => {
	it("lists memory bases apart, with their project, and keeps reindex on them", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					enabled: true,
					ready: true,
					embedding_model: "embed-1",
					extractor_model: "ocr-1",
					extractor_source: "env",
					vector_store: "pg",
					chunk_chars: 1200,
					chunk_overlap: 150,
					max_upload_bytes: 1000,
					source: "console",
					propagation_seconds: 0,
					detail: null,
					available_embedding_models: ["embed-1"],
					available_extractor_models: [],
					bases: [
						row("b1", "Team handbook"),
						row("b2", "Chats of Grants", {
							memory_of: { project_id: "p1", project_name: "Grants" },
						}),
					],
					stale_base_count: 0,
					history: [],
				})
			)
		);
		renderWithApp(Knowledge, {});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Team handbook"));

		const memory = document.body.querySelector('[data-testid="memory-bases"]');
		expect(memory?.textContent).toContain("Project chat memory");
		const tables = document.body.querySelectorAll("table");
		expect(tables).toHaveLength(2);
		expect(tables[0].textContent).toContain("Team handbook");
		expect(tables[0].textContent).not.toContain("Chats of Grants");
		expect(tables[1].textContent).toContain("Chats of Grants");
		expect(tables[1].textContent).toContain("Project: Grants");
		expect(tables[1].querySelector("button")?.textContent).toContain("Reindex");
	});
});
