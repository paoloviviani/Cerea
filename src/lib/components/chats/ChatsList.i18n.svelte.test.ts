/** The Chats list in the `en-XA` pseudo-locale: no word is spelled out in the template. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import superjson from "superjson";

import ChatsList from "./ChatsList.svelte";
import { m } from "$lib/paraglide/messages";
import { renderWithApp } from "../__tests__/renderWithApp";
import { unbracketedWords, useEnglish, usePseudoLocale } from "../__tests__/enXaManage";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const ROWS = [
	{ id: "a1", title: "Budget talk", model: "m", updatedAt: new Date().toISOString() },
	{ id: "a2", title: "Trip plan", model: "m", updatedAt: new Date().toISOString() },
];

describe("Chats list, in the pseudo-locale", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) =>
				String(input).includes("/api/v2/projects")
					? Response.json({ data: [] })
					: new Response(superjson.stringify({ conversations: ROWS, hasMore: false }))
			)
		);
		usePseudoLocale();
	});
	afterEach(() => {
		useEnglish();
		vi.unstubAllGlobals();
	});

	it("renders every word from the catalogue", async () => {
		const screen = renderWithApp(ChatsList, {} as never);
		const heading = m["chat.list.title"]({}, { locale: "en-XA" });
		expect(heading).toMatch(/^\[.+\]$/);
		await expect.element(screen.getByText(heading)).toBeVisible();
		await expect.element(screen.getByText("Budget talk")).toBeVisible();

		// Chat titles are the person's own words; the model name and the
		// relative time are data formatted by Intl.
		const stray = unbracketedWords([/^(Budget talk|Trip plan|m)$/, /ago|now|minute|second/i]);
		expect(stray).toEqual([]);
	});
});
