/** The models page in the pseudo-locale. */
import { afterEach, describe, expect, it } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import ModelsPage from "./+page.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

afterEach(() => {
	useEnglish();
	document.body.innerHTML = "";
});

describe("Models page, in the pseudo-locale", () => {
	it("renders every word from the catalogue, so none is hard-coded", async () => {
		usePseudoLocale();
		const store = writable({
			activeModel: "test/model",
			toolsOverrides: {},
			multimodalOverrides: {},
		});
		renderWithApp(
			ModelsPage,
			{
				data: {
					models: [
						{
							id: "test/model",
							displayName: "Test Model",
							description: "A model for tests",
							supportsTools: true,
							multimodal: true,
						},
						{
							id: "custom:aaaaaaaaaaaaaaaaaaaaaaaa",
							displayName: "Menu helper",
							customBase: { id: "test/model", displayName: "Test Model" },
						},
					],
				},
			} as never,
			{
				context: new Map<unknown, unknown>([
					["settings", { subscribe: store.subscribe, update: store.update, instantSet: () => {} }],
				]),
			}
		);
		const title = m["models.list.subtitle"]({}, { locale: "en-XA" });
		expect(title).toMatch(/^\[.+\]$/);
		await expect.element(page.getByText(title)).toBeVisible();
		expect(unbracketedWords(["Test Model", "A model for tests", "Menu helper"])).toEqual([]);
	});
});
