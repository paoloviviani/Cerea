/** Knowledge bases, in the pseudo-locale: the list, the form and one base. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import KnowledgeManager from "./KnowledgeManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

const ID = "a".repeat(24);
const STORE = {
	id: ID,
	name: "Team handbook",
	description: "How we work",
	owned: true,
	role: "owner",
	embedding_model: "embed-1",
	file_counts: { total: 2, completed: 1, in_progress: 1, failed: 0 },
};

function stub() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith("/vector_stores/status"))
				return Response.json({ ready: true, max_upload_bytes: 1_000_000 });
			if (url.endsWith(`/vector_stores/${ID}/files`))
				return Response.json({
					data: [
						{
							id: "d1",
							title: "policy.pdf",
							filename: "policy.pdf",
							status: "ready",
							chunk_count: 4,
							file_id: "f1",
						},
						{
							id: "d2",
							title: "draft.docx",
							filename: "draft.docx",
							status: "extracting",
							chunk_count: 0,
						},
					],
				});
			if (url.endsWith(`/vector_stores/${ID}`)) return Response.json(STORE);
			if (url.endsWith("/vector_stores")) return Response.json({ data: [STORE] });
			if (url.includes("billing/groups")) return Response.json({ data: [] });
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
}

const ALLOWED: (string | RegExp)[] = [
	"Team handbook",
	"How we work",
	"embed-1",
	"policy.pdf",
	"draft.docx",
];

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Knowledge bases, in the pseudo-locale", () => {
	it("renders the list from the catalogue", async () => {
		usePseudoLocale();
		stub();
		renderWithApp(KnowledgeManager, {});
		await expect.element(page.getByText("Team handbook")).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders the creation form from the catalogue", async () => {
		usePseudoLocale();
		stub();
		renderWithApp(KnowledgeManager, {});
		await expect.element(page.getByText("Team handbook")).toBeVisible();
		const create = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.includes(m["knowledge.manager.new"]({}, { locale: "en-XA" }))
		);
		create?.click();
		await expect
			.element(page.getByText(m["knowledge.manager.form.documents"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders one base, with its documents, from the catalogue", async () => {
		usePseudoLocale();
		stub();
		renderWithApp(KnowledgeManager, { initialId: ID });
		await expect.element(page.getByText("policy.pdf")).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});
});
