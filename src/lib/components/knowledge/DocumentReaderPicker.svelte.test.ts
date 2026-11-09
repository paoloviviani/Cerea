/** The document reader selector: the gateway's reader models, the default, plain text for a member. */
import { describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import DocumentReaderPicker from "./DocumentReaderPicker.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

describe("DocumentReaderPicker", () => {
	it("labels the default with the reader it resolves to and lists the models as given", async () => {
		renderWithApp(DocumentReaderPicker, {
			models: ["markitdown", "markitdown-ocr", "docling", "mistral-ocr"],
			defaultReader: "markitdown",
		});
		const select = page.getByRole("combobox", { name: "Read documents with" });
		await expect.element(select).toHaveDisplayValue("Default (markitdown)");
		expect(await select.getByRole("option").all()).toHaveLength(5);
		await expect.element(page.getByRole("option", { name: "docling" })).toBeInTheDocument();
		await expect.element(page.getByRole("option", { name: "mistral-ocr" })).toBeInTheDocument();
	});

	it("says plain Default when no default reader resolves", async () => {
		renderWithApp(DocumentReaderPicker, { models: ["docling"], defaultReader: null });
		await expect.element(page.getByRole("combobox")).toHaveDisplayValue("Default");
	});

	it('reports the choice as it is made, and "" for the default', async () => {
		const onchange = vi.fn();
		renderWithApp(DocumentReaderPicker, {
			models: ["markitdown", "docling"],
			defaultReader: "markitdown",
			onchange,
		});
		await page.getByRole("combobox").selectOptions("docling");
		expect(onchange).toHaveBeenLastCalledWith("docling");
		await page.getByRole("combobox").selectOptions("");
		expect(onchange).toHaveBeenLastCalledWith("");
	});

	it("shows a reader chosen earlier that the viewer cannot list as itself, not Default", async () => {
		renderWithApp(DocumentReaderPicker, {
			models: ["markitdown"],
			defaultReader: "markitdown",
			value: "private-ocr",
		});
		await expect.element(page.getByRole("combobox")).toHaveDisplayValue("private-ocr");
	});

	it("shows text only, no select, to a member who may not change it", async () => {
		renderWithApp(DocumentReaderPicker, {
			models: ["markitdown", "docling"],
			defaultReader: "markitdown",
			value: "docling",
			readonly: true,
		});
		await expect.element(page.getByText("docling")).toBeVisible();
		expect(page.getByRole("combobox").elements()).toHaveLength(0);
	});
});
