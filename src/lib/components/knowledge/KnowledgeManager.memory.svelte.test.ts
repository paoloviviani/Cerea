/** Project chat memory on the Knowledge page: apart, collapsed, read-only. */
import { afterEach, describe, expect, it, vi } from "vitest";

import KnowledgeManager from "./KnowledgeManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const base = (id: string, name: string, extra: object = {}) => ({
	id,
	name,
	description: "",
	owned: true,
	role: "owner",
	embedding_model: "embed-1",
	file_counts: { total: 2, completed: 2, in_progress: 0, failed: 0 },
	...extra,
});

function stub(data: object[]) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/vector_stores/status"))
				return Response.json({ ready: true, max_upload_bytes: 1_000_000 });
			if (url.endsWith("/vector_stores")) return Response.json({ data });
			if (url.includes("billing/groups")) return Response.json({ data: [] });
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Knowledge page and project chat memory", () => {
	it("lists ordinary bases as bases and memory bases in their own collapsed section", async () => {
		stub([
			base("a".repeat(24), "Team handbook"),
			base("b".repeat(24), "Chats of Grants", {
				memory_of: { project_id: "p1", project_name: "Grants" },
			}),
		]);
		renderWithApp(KnowledgeManager, {});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Team handbook"));

		// The count and the cards are the person's own bases only.
		expect(document.body.textContent).toContain("Yours and shared with you (1)");
		expect(document.body.textContent).not.toContain("Chats of Grants");

		const section = document.body.querySelector(
			'[data-testid="memory-bases"]'
		) as HTMLDetailsElement;
		expect(section).not.toBeNull();
		expect(section.open).toBe(false);
		expect(section.textContent).toContain("Project chat memory (1)");
		// Labelled with the project, linking to it, and nothing to change here.
		const link = section.querySelector("a") as HTMLAnchorElement;
		expect(link.getAttribute("href")).toContain("/projects/p1");
		expect(section.textContent).toContain("Grants");
		expect(section.querySelectorAll("button")).toHaveLength(0);
	});

	it("shows no section when there is no memory base", async () => {
		stub([base("a".repeat(24), "Team handbook")]);
		renderWithApp(KnowledgeManager, {});
		await vi.waitFor(() => expect(document.body.textContent).toContain("Team handbook"));
		expect(document.body.querySelector('[data-testid="memory-bases"]')).toBeNull();
	});
});
