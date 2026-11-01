import ComposerFileChips from "./ComposerFileChips.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = "";
});

describe("ComposerFileChips", () => {
	it("still reads a pending text file, so its preview is not blank", async () => {
		renderWithApp(ComposerFileChips, {
			files: [new File(["hello from a text file"], "notes.txt", { type: "text/plain" })],
		});
		await page.getByText("notes.txt").click();
		await expect.element(page.getByText("hello from a text file")).toBeVisible();
	});

	it("does not read a pending recording into memory as base64", async () => {
		const read = vi.spyOn(FileReader.prototype, "readAsDataURL");
		renderWithApp(ComposerFileChips, {
			files: [new File([new Uint8Array(16)], "memo.wav", { type: "audio/wav" })],
		});
		await expect.element(page.getByText("memo.wav")).toBeVisible();
		expect(read).not.toHaveBeenCalled();
	});
});
