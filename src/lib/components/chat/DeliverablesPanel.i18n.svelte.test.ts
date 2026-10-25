/** The Files panel in the `en-XA` pseudo-locale: no word is spelled out in the template. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeliverablesPanel from "./DeliverablesPanel.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";
import { m } from "$lib/paraglide/messages";
import { renderWithApp } from "../__tests__/renderWithApp";
import { unbracketedWords, useEnglish, usePseudoLocale } from "../__tests__/enXaManage";

const FILE = {
	name: "report.pdf",
	sha256: "a".repeat(64),
	size: 2048,
	mime: "application/pdf",
	createdAt: "2026-10-25T10:00:00.000Z",
};

describe("Files panel, in the pseudo-locale", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify({ files: [FILE] }), { status: 200 }))
		);
		usePseudoLocale();
	});
	afterEach(() => {
		useEnglish();
		vi.unstubAllGlobals();
		sidePane.close();
	});

	it("renders every word from the catalogue", async () => {
		sidePane.openLibrary();
		const screen = renderWithApp(DeliverablesPanel, undefined, {
			page: { route: { id: "/conversation/[id]" }, params: { id: "conv123456" }, data: {} },
		});
		const heading = m["chat.deliverables.from_chat"]({}, { locale: "en-XA" });
		expect(heading).toMatch(/^\[.+\]$/);
		await expect.element(screen.getByText(heading)).toBeVisible();

		// The file's name is data; its size and date are formatted by Intl, and the
		// size keeps its unit symbol.
		expect(unbracketedWords([FILE.name, /^\d/, /\b(KB|MB|B)\b/, /Oct|2026/])).toEqual([]);
	});
});
