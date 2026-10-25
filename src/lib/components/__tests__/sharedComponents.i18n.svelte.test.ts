/**
 * The shared dialogs and buttons in the `en-XA` pseudo-locale: every word on
 * them comes from the catalogue, so none can be left behind by a translation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";

import DeleteConversationModal from "../DeleteConversationModal.svelte";
import EditConversationModal from "../EditConversationModal.svelte";
import ExternalLinkModal from "../ExternalLinkModal.svelte";
import FileDrop from "../FileDrop.svelte";
import ModelPickerDialog from "../ModelPickerDialog.svelte";
import MoveMenu from "../MoveMenu.svelte";
import NavFooter from "../nav/NavFooter.svelte";
import RetryBtn from "../RetryBtn.svelte";
import StopGeneratingBtn from "../StopGeneratingBtn.svelte";
import UpdateBanner from "../UpdateBanner.svelte";
import { renderWithApp } from "./renderWithApp";
import { unbracketedWords, useEnglish, usePseudoLocale } from "./enXaManage";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

beforeEach(usePseudoLocale);
afterEach(useEnglish);

// What a person typed or the API sent: not words of ours.
const DATA = [/^(Holiday plans|Model A|alice|notes\.txt)$/, /^https:\/\/example\.com/];
const hasStray = () => expect(unbracketedWords(DATA)).toEqual([]);

describe("shared components, in the pseudo-locale", () => {
	it("the chat dialogs", async () => {
		const screens = [
			render(DeleteConversationModal, { open: true, title: "Holiday plans" }),
			render(EditConversationModal, { open: true, title: "Holiday plans" }),
			render(ExternalLinkModal, { url: new URL("https://example.com/x") }),
		];
		await expect.element(screens[0].getByText("Holiday plans")).toBeVisible();
		hasStray();
	});

	it("the buttons", async () => {
		render(RetryBtn, {});
		render(StopGeneratingBtn, {});
		render(UpdateBanner, { show: true });
		render(MoveMenu, { label: "Holiday plans", onmove: () => {}, onremove: () => {} });
		render(FileDrop, { files: [new File(["x"], "notes.txt")], maxBytes: 5 * 1024 * 1024 });
		hasStray();
	});

	it("the model picker", async () => {
		render(ModelPickerDialog, {
			models: [
				{ id: "a", name: "Model A", baseName: "Base", description: "Mine" },
				{ id: "b", name: "Model B" },
			] as never,
			currentId: "a",
			title: "Switch",
			subtitle: "Pick one",
			busy: null,
			onchoose: () => {},
			onclose: () => {},
		} as never);
		expect(unbracketedWords([...DATA, /^(Switch|Pick one|Model B|Base|Mine|· Base)$/])).toEqual([]);
	});

	it("the sidebar footer", async () => {
		renderWithApp(NavFooter, { user: { username: "alice" } } as never);
		hasStray();
	});
});
