/**
 * A phone with a large system font (390px wide, text at 130%): the "Built-in"
 * pill beside a long skill name wrapped onto two lines instead of the name
 * giving way.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import SkillsManager from "./SkillsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const NAME = "quarterly-financial-statement-reconciliation";

beforeEach(async () => {
	await page.viewport(390, 900);
	document.documentElement.style.fontSize = "130%";
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				data: {
					user: [],
					admin: [
						{
							id: "692222222222222222222222",
							name: NAME,
							description: "Reshape CSV data.",
							enabled: true,
							updatedAt: new Date().toISOString(),
							files: [],
						},
					],
				},
			})
		)
	);
	renderWithApp(SkillsManager, {});
});

afterEach(() => {
	document.documentElement.style.fontSize = "";
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("a built-in skill card at 390px with a 130% root font size", () => {
	it("keeps the Built-in pill on one line, at its own width", async () => {
		await vi.waitFor(() => expect(page.getByText(NAME).elements()).not.toHaveLength(0));
		const pill = page.getByText("Built-in", { exact: true }).element() as HTMLElement;
		const lineHeight = parseFloat(getComputedStyle(pill).lineHeight);
		expect(pill.getBoundingClientRect().height).toBeLessThan(lineHeight * 1.5);
		// The pill is as wide as its own word: the name gave way, not the pill.
		expect(pill.getBoundingClientRect().width).toBeGreaterThanOrEqual(pill.scrollWidth);
	});
});
