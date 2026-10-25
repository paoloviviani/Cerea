/** The Memory tab in the pseudo-locale: every word on it comes from the catalogue. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import MemoryManager from "./MemoryManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import {
	unbracketedWords,
	useEnglish,
	usePseudoLocale,
} from "$lib/components/__tests__/enXaManage";
import { m } from "$lib/paraglide/messages";

const fact = (id: string, text: string, source: "user" | "model") => ({
	id,
	text,
	source,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
});

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Memory, in the pseudo-locale", () => {
	it("renders every word from the catalogue, so none is hard-coded", async () => {
		usePseudoLocale();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: {
						enabled: true,
						memories: [
							fact("a".repeat(24), "Likes tea", "user"),
							fact("b".repeat(24), "Lives in Turin", "model"),
						],
					},
				})
			)
		);
		renderWithApp(MemoryManager, {}, {
			context: new Map<unknown, unknown>([["settings", writable({ memoryEnabled: false })]]),
		} as never);

		const title = m["memory.manager.title"]({}, { locale: "en-XA" });
		expect(title).toMatch(/^\[.+\]$/);
		await expect.element(page.getByText(title)).toBeVisible();
		await expect.element(page.getByText("Likes tea")).toBeVisible();

		// The facts are what the person (or the assistant) wrote.
		expect(unbracketedWords(["Likes tea", "Lives in Turin"])).toEqual([]);
	});

	it("renders the add form and the empty state in the pseudo-locale too", async () => {
		usePseudoLocale();
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: { enabled: true, memories: [] } }))
		);
		renderWithApp(MemoryManager, {}, {
			context: new Map<unknown, unknown>([["settings", writable({ memoryEnabled: true })]]),
		} as never);
		const empty = m["memory.manager.empty.title"]({}, { locale: "en-XA" });
		await expect.element(page.getByText(empty)).toBeVisible();
		const add = [...document.querySelectorAll("button")].find((b) =>
			b.textContent?.includes(m["memory.manager.add"]({}, { locale: "en-XA" }))
		);
		add?.click();
		await expect
			.element(page.getByText(m["memory.manager.new.label"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedWords()).toEqual([]);
	});
});
