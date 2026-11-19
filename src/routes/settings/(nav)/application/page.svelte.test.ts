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
			.filter((line) => !/^Cerea\b/.test(line) && line !== "English" && line !== "Italiano");
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
		expect(options()).toEqual(["auto", "en", "it"]);
		real.unmount();

		page.data = { pseudoLocaleEnabled: true };
		const dev = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		await expect.element(dev.getByLabelText("Language")).toBeVisible();
		expect(options()).toEqual(["auto", "en", "it", "en-XA"]);
	});
});

describe("Settings > Application, the language picker", () => {
	it("shows 'use my browser's language' until a language has been chosen, then the choice", async () => {
		page.data = { pseudoLocaleEnabled: false };
		const select = () => document.querySelector<HTMLSelectElement>("#language-select");
		const none = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		await expect.element(none.getByLabelText("Language")).toBeVisible();
		expect(select()?.value).toBe("auto");
		expect(select()?.selectedOptions[0]?.textContent).toBe("Use my browser's language");
		none.unmount();

		const store = writable({ activeModel: "", locale: "it" });
		const context = new Map<unknown, unknown>([
			[
				"settings",
				{ subscribe: store.subscribe, update: vi.fn(), instantSet: vi.fn(), set: vi.fn() },
			],
		]);
		const chosen = renderWithApp(ApplicationPage, {}, { context, page });
		await expect.element(chosen.getByLabelText("Language")).toBeVisible();
		expect(select()?.value).toBe("it");
		expect(select()?.selectedOptions[0]?.textContent).toBe("Italiano");
	});
});

describe("Settings > Application, the PyPI install option", () => {
	const row = () =>
		document.querySelector<HTMLInputElement>('input[name="pyodidePyPiInstallEnabled"]');

	it("shows the option, on by default, when the deployment allows it", async () => {
		page.data = { pyodidePyPiInstallAllowed: true };
		const screen = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		await expect.element(screen.getByText("Let code install extra Python packages")).toBeVisible();
		expect(row()?.checked).toBe(true);
	});

	it("shows it off when the user stored false", async () => {
		page.data = { pyodidePyPiInstallAllowed: true };
		const store = writable({ activeModel: "", pyodidePyPiInstallEnabled: false });
		const context = new Map<unknown, unknown>([
			[
				"settings",
				{ subscribe: store.subscribe, update: vi.fn(), instantSet: vi.fn(), set: vi.fn() },
			],
		]);
		const screen = renderWithApp(ApplicationPage, {}, { context, page });
		await expect.element(screen.getByText("Let code install extra Python packages")).toBeVisible();
		expect(row()?.checked).toBe(false);
	});

	it("hides the whole row when the administrator switched it off", async () => {
		page.data = { pyodidePyPiInstallAllowed: false };
		const screen = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		await expect.element(screen.getByText("Appearance")).toBeVisible();
		expect(row()).toBeNull();
		expect(document.body.textContent).not.toContain("Let code install extra Python packages");
	});

	it("hides the row when the model's code runs in the server sandbox", async () => {
		page.data = { pyodidePyPiInstallAllowed: true, modelCodeOnServer: true };
		const screen = renderWithApp(ApplicationPage, {}, { context: stores(), page });
		await expect.element(screen.getByText("Appearance")).toBeVisible();
		expect(row()).toBeNull();
	});
});

describe("Settings > Application, the web search opt-out", () => {
	const row = () => document.querySelector<HTMLInputElement>('input[name="webSearchEnabled"]');
	const withSettings = (value: Record<string, unknown>) => {
		const store = writable({ activeModel: "", ...value });
		return new Map<unknown, unknown>([
			[
				"settings",
				{ subscribe: store.subscribe, update: vi.fn(), instantSet: vi.fn(), set: vi.fn() },
			],
		]);
	};

	it("is on by default, also for a settings document that never stored it", async () => {
		page.data = { webSearchAvailable: true };
		const screen = renderWithApp(ApplicationPage, {}, { context: withSettings({}), page });
		await expect.element(screen.getByText("Use web search when available")).toBeVisible();
		expect(row()?.checked).toBe(true);
	});

	it("shows off only when the user stored false", async () => {
		page.data = { webSearchAvailable: true };
		const screen = renderWithApp(
			ApplicationPage,
			{},
			{ context: withSettings({ webSearchEnabled: false }), page }
		);
		await expect.element(screen.getByText("Use web search when available")).toBeVisible();
		expect(row()?.checked).toBe(false);
	});

	it("is disabled, with the reason, when no search backend is granted", async () => {
		page.data = { webSearchAvailable: false };
		const screen = renderWithApp(ApplicationPage, {}, { context: withSettings({}), page });
		await expect.element(screen.getByText("Use web search when available")).toBeVisible();
		expect(row()?.disabled).toBe(true);
		// Stored value defaults to on, but unavailable shows off.
		expect(row()?.checked).toBe(false);
		expect(document.body.textContent).toContain("Web search isn't set up here yet.");
	});
});

describe("Settings > Application, web search when unavailable", () => {
	it("shows off and disabled even when the stored value is on, without writing it", async () => {
		page.data = { webSearchAvailable: false };
		const ctx = stores();
		const screen = renderWithApp(ApplicationPage, {}, { context: ctx, page });
		await expect.element(screen.getByText("Use web search when available")).toBeVisible();
		const input = document.querySelector<HTMLInputElement>('input[name="webSearchEnabled"]');
		expect(input?.checked).toBe(false);
		expect(input?.disabled).toBe(true);
		const s = ctx.get("settings") as { update: ReturnType<typeof vi.fn> };
		expect(s.update).not.toHaveBeenCalled();
	});
});

describe("Settings > Application, About this server", () => {
	it("folds the version, gateway address and admin badge away, with a space before the commit", async () => {
		page.data = { isAdmin: true };
		renderWithApp(ApplicationPage, {}, { context: stores(), page });
		const about = document.querySelector<HTMLDetailsElement>('[data-testid="about-server"]');
		if (!about) throw new Error("no About row");
		expect(about.open).toBe(false);
		expect(about.querySelector("summary")?.textContent).toContain("About this server");
		expect(about.textContent).toContain("You're an administrator");
		// The page's first element is a setting, not a version string.
		expect(document.querySelector('[data-testid="app-version"]')?.closest("details")).toBe(about);
		const version = document.querySelector('[data-testid="app-version"]')?.textContent ?? "";
		if (/·/.test(version)) expect(version).toMatch(/\d\s·\s[0-9a-f]{7}$/);
	});
});

describe("Settings > Application, hidden values in the turn details", () => {
	it("is off by default, with its one line of help, and turning it on saves the setting", async () => {
		const context = stores();
		const settings = context.get("settings") as { update: ReturnType<typeof vi.fn> };
		const screen = renderWithApp(ApplicationPage, {}, { context });
		await expect.element(screen.getByText("Show hidden values in the turn details")).toBeVisible();
		await expect
			.element(
				screen.getByText(
					"The values come from the gateway for that answer only and are kept with the chat, where the original text already is."
				)
			)
			.toBeVisible();
		const input = document.querySelector<HTMLInputElement>('input[name="showRedactionValues"]');
		expect(input?.checked).toBe(false);

		(input?.nextElementSibling as HTMLElement).click();
		const update = settings.update.mock.calls.at(-1)?.[0] as
			((s: Record<string, unknown>) => Record<string, unknown>) | undefined;
		expect(update?.({})).toMatchObject({ showRedactionValues: true });
	});
});
