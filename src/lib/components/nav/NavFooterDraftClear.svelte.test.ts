import NavFooter from "./NavFooter.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { chatDraftKey, codeDraftKey, writeComposerDraft } from "$lib/utils/composerDraft";

/**
 * Signing out clears this device's composer drafts first: on a shared
 * browser the next person must not see the previous person's unsent text.
 * The sign-out itself stays a plain form post — the clearing runs in its
 * submit handler, synchronously, before the POST leaves.
 */
describe("NavFooter sign-out clears composer drafts", () => {
	let host: HTMLElement;
	let mounted: Array<{ unmount: () => void }> = [];

	beforeEach(() => {
		mounted = [];
		localStorage.removeItem("theme");
		document.documentElement.classList.remove("dark");
		for (let i = localStorage.length - 1; i >= 0; i--) {
			const key = localStorage.key(i);
			if (key?.startsWith("cerea:composer-draft:")) localStorage.removeItem(key);
		}
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		for (const screen of mounted) screen.unmount();
		host.remove();
		localStorage.removeItem("theme");
		document.documentElement.classList.remove("dark");
		vi.restoreAllMocks();
	});

	function mount() {
		const screen = renderWithApp(NavFooter, { user: { username: "ada" } } as never, {
			baseElement: host,
		});
		mounted.push(screen);
		return screen;
	}

	function submitSignOut() {
		const form = host.querySelector("form");
		if (!form) throw new Error("no sign-out form");
		// A synthetic submit runs the listeners without navigating away from
		// the test page; the handler under test is synchronous.
		form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
	}

	for (const [label, width] of [
		["desktop", 1280],
		["mobile", 390],
	] as const) {
		it(`signing out drops every draft key (${label})`, async () => {
			await browserPage.viewport(width, 800);
			mount();
			writeComposerDraft(chatDraftKey("home"), "unsent home thought");
			writeComposerDraft(chatDraftKey("conv123"), "unsent chat reply");
			writeComposerDraft(codeDraftKey("d1", "a1"), "unsent follow-up");
			localStorage.setItem("theme", "dark");

			submitSignOut();

			expect(localStorage.getItem(chatDraftKey("home"))).toBeNull();
			expect(localStorage.getItem(chatDraftKey("conv123"))).toBeNull();
			expect(localStorage.getItem(codeDraftKey("d1", "a1"))).toBeNull();
			// …but nothing outside the draft prefix is touched.
			expect(localStorage.getItem("theme")).toBe("dark");
		});

		it(`signing out with no drafts stored is a no-op (${label})`, async () => {
			await browserPage.viewport(width, 800);
			mount();
			localStorage.setItem("theme", "light");

			expect(() => submitSignOut()).not.toThrow();
			expect(localStorage.getItem("theme")).toBe("light");
		});
	}
});
