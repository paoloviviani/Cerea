/** A user's default reader: saved on change, and put back when the save fails. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import DocumentReaderSetting from "./DocumentReaderSetting.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

afterEach(() => vi.unstubAllGlobals());

function stub(putStatus: number) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: { method?: string }) => {
			if (init?.method === "PUT") {
				return putStatus === 200
					? Response.json({ reader_model: "docling" })
					: Response.json(
							{ message: "“docling” is not a document reader you can use." },
							{ status: putStatus }
						);
			}
			return Response.json({
				reader_model: "markitdown",
				reader_models: ["markitdown", "docling"],
				reader_default: "markitdown",
			});
		})
	);
}

describe("DocumentReaderSetting", () => {
	it("keeps the new choice when the save works", async () => {
		stub(200);
		renderWithApp(DocumentReaderSetting, {});
		const select = page.getByRole("combobox");
		await expect.element(select).toHaveDisplayValue("markitdown");
		await select.selectOptions("docling");
		await expect.element(select).toHaveDisplayValue("docling");
	});

	it("puts the select back and says why when the save is refused", async () => {
		stub(400);
		renderWithApp(DocumentReaderSetting, {});
		const select = page.getByRole("combobox");
		await expect.element(select).toHaveDisplayValue("markitdown");
		await select.selectOptions("docling");
		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("not a document reader you can use");
		await expect.element(select).toHaveDisplayValue("markitdown");
	});
});
