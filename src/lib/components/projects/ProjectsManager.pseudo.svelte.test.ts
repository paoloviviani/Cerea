/** The projects list in the pseudo-locale: every word on it comes from the catalogue. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import ProjectsManager from "./ProjectsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

const project = (id: string, name: string, extra: object = {}) => ({
	id,
	name,
	description: "",
	instructions: "",
	knowledgeBaseIds: [],
	indexPastChats: false,
	hasMemory: false,
	retrievalLimit: 6,
	owned: true,
	shares: [],
	conversationCount: 2,
	updatedAt: "2026-01-01T00:00:00.000Z",
	...extra,
});

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Projects list, in the pseudo-locale", () => {
	it("renders every word from the catalogue, so none is hard-coded", async () => {
		usePseudoLocale();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: [
						project("p1", "Grant application", {
							knowledgeBaseIds: ["k1"],
							indexPastChats: true,
						}),
						project("p2", "Annual report", { owned: false, conversationCount: 1 }),
					],
				})
			)
		);
		renderWithApp(ProjectsManager, {}, { page: { data: { knowledgeEnabled: true } } });

		const title = m["projects.manager.title"]({}, { locale: "en-XA" });
		expect(title).toMatch(/^\[.+\]$/);
		await expect.element(page.getByText(title)).toBeVisible();
		await expect.element(page.getByText("Grant application")).toBeVisible();

		expect(unbracketedWords(["Grant application", "Annual report"])).toEqual([]);
	});

	it("renders the empty state in the pseudo-locale too", async () => {
		usePseudoLocale();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [] }))
		);
		renderWithApp(ProjectsManager, {});
		await expect
			.element(page.getByText(m["projects.manager.empty.title"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedWords()).toEqual([]);
	});
});
