/** Custom models, in the pseudo-locale: the list with a card, and the form. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import CustomModelsManager from "./CustomModelsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

const MODELS = [{ id: "test/glm", displayName: "GLM Flash" }];
const EXISTING = {
	id: "custom:aaaaaaaaaaaaaaaaaaaaaaaa",
	name: "Menu helper",
	description: "Plans lunches",
	baseModelId: "test/glm",
	systemPrompt: "You plan menus.",
};

const context = () => {
	const store = writable<Record<string, unknown>>({
		activeModel: "test/glm",
		globalSystemPrompt: "",
	});
	return new Map<unknown, unknown>([
		["settings", { subscribe: store.subscribe, update: vi.fn(), instantSet: vi.fn() }],
	]);
};

const ALLOWED = ["GLM Flash", "Menu helper", "Plans lunches", "You plan menus."];

afterEach(() => {
	useEnglish();
	document.body.innerHTML = "";
});

describe("Custom models, in the pseudo-locale", () => {
	it("renders the list and its card from the catalogue", async () => {
		usePseudoLocale();
		renderWithApp(CustomModelsManager, { models: MODELS, customModels: [EXISTING] } as never, {
			context: context(),
		});
		await expect.element(page.getByText("Menu helper").first()).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});

	it("renders the empty state and the creation form from the catalogue", async () => {
		usePseudoLocale();
		renderWithApp(CustomModelsManager, { models: MODELS, customModels: [] } as never, {
			context: context(),
		});
		const empty = m["models.custom.empty.title"]({}, { locale: "en-XA" });
		await expect.element(page.getByText(empty)).toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);

		const add = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.includes(m["models.custom.new"]({}, { locale: "en-XA" }))
		);
		add?.click();
		await expect
			.element(page.getByText(m["models.custom.form.base"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedWords(ALLOWED)).toEqual([]);
	});
});
