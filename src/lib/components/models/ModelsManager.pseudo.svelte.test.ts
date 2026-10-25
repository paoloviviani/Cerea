/** The models list and one model's settings, in the pseudo-locale. */
import { afterEach, describe, expect, it } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import ModelsManager from "./ModelsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

const MODELS = [
	{
		id: "test/model",
		displayName: "Test Model",
		description: "A model for tests",
		supportsTools: true,
		multimodal: true,
		supportsReasoning: true,
	},
	{
		id: "custom:aaaaaaaaaaaaaaaaaaaaaaaa",
		displayName: "Menu helper",
		customBase: { id: "test/model", displayName: "Test Model" },
	},
];

const context = () => {
	const store = writable({
		activeModel: "test/model",
		multimodalOverrides: {},
		toolsOverrides: { "test/model": false },
		artifactsOverrides: {},
		reasoningOverrides: {},
	});
	return new Map<unknown, unknown>([
		["settings", { subscribe: store.subscribe, update: store.update, instantSet: async () => {} }],
	]);
};

const ALLOWED = ["Test Model", "A model for tests", "Menu helper", "test/model", /^custom:/];

afterEach(() => {
	useEnglish();
	document.body.innerHTML = "";
});

describe("Models, in the pseudo-locale", () => {
	it("renders the list from the catalogue", async () => {
		usePseudoLocale();
		renderWithApp(ModelsManager, { models: MODELS } as never, { context: context() });
		const title = m["models.manager.subtitle"]({}, { locale: "en-XA" });
		expect(title).toMatch(/^\[.+\]$/);
		await expect.element(page.getByText(title)).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders one model's settings from the catalogue", async () => {
		usePseudoLocale();
		renderWithApp(ModelsManager, { models: MODELS, initialId: "test/model" } as never, {
			context: context(),
		});
		const heading = m["models.manager.detail.may_do"]({}, { locale: "en-XA" });
		await expect.element(page.getByText(heading)).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});
});
