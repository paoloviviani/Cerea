import { afterEach, describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import { page } from "$lib/components/__tests__/appMocks";
import ApplicationPage from "./+page.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const stores = () => {
	const store = writable({
		activeModel: "",
		streamingMode: "smooth",
		directPaste: false,
		hapticsEnabled: true,
		recentlySaved: false,
	});
	return new Map<unknown, unknown>([
		[
			"settings",
			{ subscribe: store.subscribe, update: vi.fn(), instantSet: vi.fn(), set: vi.fn() },
		],
	]);
};

afterEach(() => {
	// Back to the page's own resolution (the cookie, then English).
	overwriteGetLocale(() => "en");
});

describe("Settings > Application, in the pseudo-locale", () => {
	it("renders in English by default", async () => {
		const screen = renderWithApp(ApplicationPage, {}, { context: stores() });
		await expect.element(screen.getByText("Appearance")).toBeVisible();
		await expect.element(screen.getByText("How replies appear")).toBeVisible();
		await expect.element(screen.getByText("Delete all chats")).toBeVisible();
	});

	it("renders every word from the catalogue in en-XA, so none is hard-coded", async () => {
		overwriteGetLocale(() => "en-XA");
		const screen = renderWithApp(ApplicationPage, {}, { context: stores() });

		for (const key of [
			"settings.application.appearance.heading",
			"settings.application.streaming.title",
			"settings.application.delete_all.button",
		] as const) {
			const word = m[key]({}, { locale: "en-XA" });
			expect(word).toMatch(/^\[.+\]$/);
			await expect.element(screen.getByText(word)).toBeVisible();
		}

		// A rendered word that is not bracketed is one the catalogue does not own.
		// The only literals: the version line, and a language written in itself (the
		// selector shows "English" in every locale on purpose).
		const text = document.body.innerText;
		const unmarked = text
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => /[A-Za-z]{3,}/.test(line) && !line.includes("["))
			.filter((line) => !/^Cerea\b/.test(line) && line !== "English");
		expect(unmarked).toEqual([]);
	});

	it("offers only real languages unless the server says the pseudo-locale may be chosen", async () => {
		page.data = { pseudoLocaleEnabled: false };
		const real = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		const options = () =>
			[...document.querySelectorAll<HTMLOptionElement>("#language-select option")].map(
				(o) => o.value
			);
		await expect.element(real.getByLabelText("Language")).toBeVisible();
		expect(options()).toEqual(["en"]);
		real.unmount();

		page.data = { pseudoLocaleEnabled: true };
		const dev = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		await expect.element(dev.getByLabelText("Language")).toBeVisible();
		expect(options()).toEqual(["en", "en-XA"]);
	});
});
