/**
 * A phone with a large system font (390px wide, text at 130%): the memory
 * card kept its Edit and Delete beside the text, so the text got one or two
 * words per line, and "Remembered for you" broke onto two lines.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import MemoryManager from "./MemoryManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const TEXT = "Prefers concise answers with a short example, and never a long preamble.";

beforeEach(async () => {
	await page.viewport(390, 900);
	document.documentElement.style.fontSize = "130%";
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			Response.json({
				data: {
					enabled: true,
					memories: [
						{
							id: "a".repeat(24),
							text: TEXT,
							source: "model",
							createdAt: "2026-01-01T00:00:00.000Z",
							updatedAt: "2026-01-01T00:00:00.000Z",
						},
					],
				},
			})
		)
	);
	renderWithApp(MemoryManager, {}, {
		context: new Map<unknown, unknown>([["settings", writable({ memoryEnabled: true })]]),
	} as never);
});

afterEach(() => {
	document.documentElement.style.fontSize = "";
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("a memory card at 390px with a 130% root font size", () => {
	it("keeps the pill on one line and gives the text most of the card", async () => {
		await expect.element(page.getByText(TEXT)).toBeVisible();
		const text = page.getByText(TEXT).element() as HTMLElement;
		const pill = page.getByText("Remembered for you").element() as HTMLElement;
		const card = text.closest("div.rounded-lg") as HTMLElement;

		const lineHeight = parseFloat(getComputedStyle(pill).lineHeight);
		expect(pill.getBoundingClientRect().height).toBeLessThan(lineHeight * 1.5);
		expect(text.getBoundingClientRect().width).toBeGreaterThan(
			card.getBoundingClientRect().width * 0.6
		);
		// Nothing pokes out of the card sideways.
		expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
	});
});
