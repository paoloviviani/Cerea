import { afterEach, describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";
import WorkspacePanel from "./WorkspacePanel.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

afterEach(() => {
	vi.unstubAllGlobals();
	overwriteGetLocale(() => "en");
});

describe("The Workspace tabs, in the pseudo-locale", () => {
	it("names every tab and the page from the catalogue", async () => {
		overwriteGetLocale(() => "en-XA");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [], machines: [] }))
		);
		const screen = renderWithApp(
			WorkspacePanel,
			{ data: { models: [], localConnectorsEnabled: true } } as never,
			{
				page: { url: "http://localhost:3000/workspace?tab=local" },
				context: new Map<unknown, unknown>([["settings", writable({ activeModel: "" })]]),
			}
		);
		for (const key of [
			"workspace.title",
			"workspace.tab.models",
			"workspace.tab.custom",
			"workspace.tab.memory",
			"workspace.tab.kb",
			"workspace.tab.skills",
			"workspace.tab.mcp",
			"workspace.tab.local",
		] as const) {
			const word = m[key]({}, { locale: "en-XA" });
			expect(word).toMatch(/^\[.+\]$/);
			expect(screen.baseElement.textContent).toContain(word);
		}
	});
});
