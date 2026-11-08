/** The embedding-model selector: options, the plain-text cases, the inline confirm. */
import { describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import EmbeddingModelPicker from "./EmbeddingModelPicker.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

describe("EmbeddingModelPicker", () => {
	it("labels the default and lists the user's models", async () => {
		renderWithApp(EmbeddingModelPicker, {
			models: ["bge-m3", "e5-large"],
			defaultModel: "bge-m3",
		});
		const select = page.getByRole("combobox", { name: "Embedding model" });
		await expect.element(select).toHaveDisplayValue("Default (bge-m3)");
		const options = await select.getByRole("option").all();
		expect(options).toHaveLength(2);
		await expect.element(page.getByRole("option", { name: "e5-large" })).toBeInTheDocument();
	});

	it("shows plain text, not a select, when there is only one model", async () => {
		renderWithApp(EmbeddingModelPicker, { models: ["bge-m3"], defaultModel: "bge-m3" });
		await expect.element(page.getByText("bge-m3")).toBeVisible();
		expect(page.getByRole("combobox").elements()).toHaveLength(0);
	});

	it("shows the name only to a user who may not manage the base", async () => {
		renderWithApp(EmbeddingModelPicker, {
			models: ["bge-m3", "e5-large"],
			defaultModel: "bge-m3",
			current: "e5-large",
			readonly: true,
			confirmCount: 4,
		});
		await expect.element(page.getByText("e5-large")).toBeVisible();
		expect(page.getByRole("combobox").elements()).toHaveLength(0);
	});

	it("asks inline before changing, and only then reports the choice", async () => {
		const onconfirm = vi.fn();
		renderWithApp(EmbeddingModelPicker, {
			models: ["bge-m3", "e5-large"],
			defaultModel: "bge-m3",
			current: "bge-m3",
			value: "",
			confirmCount: 7,
			onconfirm,
		});
		await page.getByRole("combobox").selectOptions("e5-large");
		await expect
			.element(page.getByText("Changing the embedder reindexes all 7 documents."))
			.toBeVisible();
		expect(onconfirm).not.toHaveBeenCalled();

		await page.getByRole("button", { name: "Cancel" }).click();
		expect(page.getByTestId("embedding-confirm").elements()).toHaveLength(0);

		await page.getByRole("combobox").selectOptions("e5-large");
		await page.getByRole("button", { name: "Change and reindex" }).click();
		expect(onconfirm).toHaveBeenCalledExactlyOnceWith("e5-large");
	});

	it("shows the real name of a chosen model the viewer cannot list, not Default", async () => {
		renderWithApp(EmbeddingModelPicker, {
			models: ["bge-m3", "e5-large"],
			defaultModel: "bge-m3",
			value: "private-embed",
			current: "private-embed",
		});
		await expect.element(page.getByRole("combobox")).toHaveDisplayValue("private-embed");
	});

	it("offers no Default option when there is no deployment default", async () => {
		renderWithApp(EmbeddingModelPicker, {
			models: ["bge-m3", "e5-large"],
			defaultModel: null,
			value: "bge-m3",
			required: true,
		});
		const options = await page.getByRole("combobox").getByRole("option").all();
		expect(options).toHaveLength(2);
		await expect.element(page.getByRole("combobox")).toHaveDisplayValue("bge-m3");
	});
});
