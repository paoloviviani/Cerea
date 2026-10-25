/**
 * The composer in the `en-XA` pseudo-locale: its placeholder, its pills and
 * its attachment menu say only what the catalogue says.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";

import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { unbracketed, useEnglish, usePseudoLocale } from "../__tests__/pseudoLocale";
import {
	connectors,
	connectorsFailed,
	connectorsLoaded,
	resetConversationSelections,
} from "$lib/stores/mcpConnectors";
import { allMcpServers } from "$lib/stores/mcpServers";
import { m } from "$lib/paraglide/messages";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const CONV_ID = "0123456789abcdef01234567";

/** The trigger opens on Enter, not on a synthetic pointerdown (see ChatInput.svelte.test.ts). */
const fireTap = (el: HTMLElement) => {
	el.focus();
	el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

beforeEach(() => {
	document.getElementById("app")?.remove();
	connectors.set([]);
	connectorsLoaded.set(true);
	connectorsFailed.set(false);
	resetConversationSelections();
	allMcpServers.set([]);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL) =>
			String(url).endsWith("/vector_stores")
				? new Response(JSON.stringify({ data: [] }), { status: 200 })
				: new Response(JSON.stringify({ data: [] }), { status: 200 })
		)
	);
	usePseudoLocale();
});

afterEach(() => {
	useEnglish();
	vi.unstubAllGlobals();
	document.getElementById("app")?.remove();
});

describe("Composer, in the pseudo-locale", () => {
	it("renders every word from the catalogue, menu included", async () => {
		const host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
		renderWithApp(
			ChatInput,
			{ knowledgeBases: [], mimeTypes: ["text/plain", "image/png"], webSearch: false },
			{
				page: {
					params: { id: CONV_ID },
					data: { user: { username: "tester" }, loginEnabled: true },
				},
				baseElement: host,
				context: new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]),
			}
		);

		const attach = m["chat.input.attach"]({}, { locale: "en-XA" });
		expect(attach).toMatch(/^\[.+\]$/);
		const button = host.querySelector<HTMLElement>(`button[aria-label="${attach}"]`);
		expect(button).not.toBeNull();
		fireTap(button as HTMLElement);
		const knowledge = m["chat.input.knowledge"]({}, { locale: "en-XA" });
		await vi.waitFor(() => expect(document.body.textContent).toContain(knowledge), {
			timeout: 5000,
		});

		expect(unbracketed()).toEqual([]);
	});
});
