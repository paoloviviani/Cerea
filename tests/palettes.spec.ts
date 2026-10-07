/**
 * Settings → Appearance: the accent and the background tone.
 *
 * What is pinned, end to end: picking applies instantly (attributes on <html>),
 * saves to the person's account, and comes back from the *server-rendered*
 * document on the next load (so there is no flash of blue while the client
 * boots); and that the remap really reaches Tailwind's compiled utilities
 * (`bg-blue-600`, the opacity ones, `text-gray-800`) and the semantic tokens,
 * in light and in dark. The defaults carry no attribute at all.
 */
import { test, expect, E2E_APP_BASE } from "./fixtures";
import type { Page } from "playwright/test";

const SETTINGS = `${E2E_APP_BASE}/settings/application`;

const saved = (page: Page) =>
	page.waitForResponse(
		(r) => r.request().method() === "POST" && new URL(r.url()).pathname.endsWith("/settings")
	);

/** The computed colour a probe element gets from the compiled stylesheet. */
async function utilityColours(page: Page) {
	return page.evaluate(() => {
		const probe = (cls: string, prop: "backgroundColor" | "color" | "borderTopColor") => {
			const el = document.createElement("div");
			el.className = cls;
			document.body.append(el);
			const value = getComputedStyle(el)[prop];
			el.remove();
			return value;
		};
		const mixed = (css: string) => {
			const el = document.createElement("div");
			el.style.backgroundColor = css;
			document.body.append(el);
			const value = getComputedStyle(el).backgroundColor;
			el.remove();
			return value;
		};
		return {
			solid: probe("bg-blue-600", "backgroundColor"),
			mid: probe("bg-blue-500", "backgroundColor"),
			subtle: probe("bg-blue-50", "backgroundColor"),
			ink: probe("text-gray-800", "color"),
			// An opacity modifier: Tailwind also writes a baked-in literal for this, which
			// would stay blue if the colour-mix form were not the one in force.
			tint: probe("bg-blue-500/10", "backgroundColor"),
			tintExpected: mixed("color-mix(in oklab, #009689 10%, transparent)"),
		};
	});
}

test.describe("Appearance", () => {
	test("the defaults carry no attribute and keep today's look", async ({ page }) => {
		const response = await page.goto(SETTINGS);
		expect(await response?.text()).not.toMatch(/<html[^>]*data-(accent|neutral)/);
		await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.*/);
		await expect(page.locator("html")).not.toHaveAttribute("data-neutral", /.*/);

		await expect(page.getByRole("radio", { name: "Blue" })).toHaveAttribute("aria-checked", "true");
		await expect(page.getByRole("radio", { name: "Gray" })).toHaveAttribute("aria-checked", "true");

		await page.goto(`${E2E_APP_BASE}/`);
		await page.locator("textarea").first().fill("hello");
		await expect(page.getByRole("button", { name: "Send message" })).toBeEnabled();
		await expect(page.getByRole("button", { name: "Send message" })).toHaveCSS(
			"background-color",
			"rgb(37, 99, 235)"
		);
	});

	test("Teal + Stone: instant, saved, and in the server-rendered <html> after a reload", async ({
		page,
	}) => {
		await page.goto(SETTINGS);
		const html = page.locator("html");

		const firstSave = saved(page);
		await page.getByRole("radio", { name: "Teal" }).click();
		// Instant: before the save has even come back.
		await expect(html).toHaveAttribute("data-accent", "teal");
		await expect(page.getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
		await expect(page.getByRole("radio", { name: "Blue" })).toHaveAttribute(
			"aria-checked",
			"false"
		);
		expect((await firstSave).ok()).toBe(true);

		const secondSave = saved(page);
		await page.getByRole("radio", { name: "Stone" }).click();
		await expect(html).toHaveAttribute("data-neutral", "stone");
		expect((await secondSave).ok()).toBe(true);

		// The document the server sends, before any script runs.
		const served = await (await page.request.get(SETTINGS)).text();
		expect(served).toMatch(/<html[^>]*data-accent="teal"/);
		expect(served).toMatch(/<html[^>]*data-neutral="stone"/);

		await page.reload();
		await expect(html).toHaveAttribute("data-accent", "teal");
		await expect(html).toHaveAttribute("data-neutral", "stone");
		await expect(page.getByRole("radio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
		await expect(page.getByRole("radio", { name: "Stone" })).toHaveAttribute(
			"aria-checked",
			"true"
		);

		// The send button, on the chat page.
		await page.goto(`${E2E_APP_BASE}/`);
		await page.locator("textarea").first().fill("hello");
		const send = page.getByRole("button", { name: "Send message" });
		await expect(send).toBeEnabled();
		await expect(send).toHaveCSS("background-color", "rgb(0, 120, 111)"); // teal-700
		await expect(send).toHaveCSS("color", "rgb(255, 255, 255)");

		// The remap reaches Tailwind's own utilities, not just the tokens.
		const c = await utilityColours(page);
		expect(c.solid).toBe("rgb(0, 120, 111)"); // bg-blue-600 → teal-700
		expect(c.mid).toBe("rgb(0, 150, 137)"); // bg-blue-500 → teal-600
		expect(c.subtle).toBe("rgb(240, 253, 250)"); // bg-blue-50 → teal-50
		expect(c.ink).toBe("rgb(28, 25, 23)"); // text-gray-800 → stone-900
		expect(c.tint).toBe(c.tintExpected); // bg-blue-500/10 → teal-600 at 10%
		await expect(page.locator("body")).toHaveCSS("background-color", "rgb(250, 250, 249)"); // stone-50
	});

	test("back to Blue + Gray removes the attributes and the saved choice sticks", async ({
		page,
	}) => {
		await page.goto(SETTINGS);
		let save = saved(page);
		await page.getByRole("radio", { name: "Violet" }).click();
		await save;
		save = saved(page);
		await page.getByRole("radio", { name: "Slate" }).click();
		await save;
		await expect(page.locator("html")).toHaveAttribute("data-accent", "violet");

		save = saved(page);
		await page.getByRole("radio", { name: "Blue" }).click();
		await save;
		save = saved(page);
		await page.getByRole("radio", { name: "Gray" }).click();
		await save;
		await expect(page.locator("html")).not.toHaveAttribute("data-accent", /.*/);
		await expect(page.locator("html")).not.toHaveAttribute("data-neutral", /.*/);

		const served = await (await page.request.get(SETTINGS)).text();
		expect(served).not.toMatch(/<html[^>]*data-(accent|neutral)/);
	});

	test("works in dark mode too", async ({ page }) => {
		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto(SETTINGS);
		const save = saved(page);
		await page.getByRole("radio", { name: "Teal" }).click();
		await save;
		const save2 = saved(page);
		await page.getByRole("radio", { name: "Stone" }).click();
		await save2;

		await page.reload();
		const html = page.locator("html");
		await expect(html).toHaveClass(/dark/);
		await expect(html).toHaveAttribute("data-accent", "teal");
		const tokens = await page.evaluate(() => {
			const cs = getComputedStyle(document.documentElement);
			const read = (n: string) => cs.getPropertyValue(n).trim();
			return {
				accent: read("--colour-accent"),
				subtle: read("--colour-accent-subtle"),
				solid: read("--colour-accent-solid"),
				bg: read("--colour-bg"),
				surface: read("--colour-surface"),
			};
		});
		expect(tokens).toEqual({
			accent: "#00d5be", // teal-400
			subtle: "#022f2e", // teal-950
			solid: "#00786f", // teal-700, pinned across themes
			bg: "#0c0a09", // stone-950
			surface: "#1c1917", // stone-900
		});
		await expect(page.locator("body")).toHaveCSS("background-color", "rgb(12, 10, 9)");
	});

	test("the swatches are a keyboard radio group", async ({ page }) => {
		await page.goto(SETTINGS);
		const save = saved(page);
		const blue = page.getByRole("radio", { name: "Blue" });
		await blue.focus();
		await page.keyboard.press("ArrowRight");
		await save;
		await expect(page.getByRole("radio", { name: "Violet" })).toBeFocused();
		await expect(page.getByRole("radio", { name: "Violet" })).toHaveAttribute(
			"aria-checked",
			"true"
		);
		await expect(page.locator("html")).toHaveAttribute("data-accent", "violet");
	});
});
