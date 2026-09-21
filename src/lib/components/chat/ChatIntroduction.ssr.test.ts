import { render } from "svelte/server";
import { describe, it, expect, vi } from "vitest";
import ChatIntroduction from "./ChatIntroduction.svelte";
import { getConfigManager } from "$lib/utils/PublicConfig.svelte";
import type { Model } from "$lib/types/Model";

// Logo reads publicConfig.assetPath, which touches $app/state's page.url —
// meaningful only inside a live SvelteKit request. A static stand-in keeps
// the component's own SSR behaviour under test without the runtime.
vi.mock("$app/state", () => ({
	page: { url: new URL("http://localhost:3000/chat/") },
	navigating: { from: null, to: null, type: null, willUnload: false, delta: undefined },
	updated: { current: false, check: async () => false },
}));

/**
 * The phrase beside the app name is picked in onMount, which the server
 * render never runs — so the SSR payload must carry the plain name and no
 * phrase at all. A pick in the script body would ship one phrase in the
 * payload and (usually) another after hydration: a mismatch warning on
 * every page load. These tests pin that contract.
 */

const model = { id: "m", displayName: "Model", name: "model" } as unknown as Model;
const PHRASES = ["Com'è?", "Va bin", "Facciamo che iniziare?", "Oh basta là"];

const manager = getConfigManager({
	PUBLIC_APP_NAME: "chat-ui",
	PUBLIC_TURIN_PHRASES: `"${PHRASES.join(",")}"`,
});

// The manager is a module singleton; the introduction reads it through
// the "publicConfig" context — the same key + manager shape +layout.svelte
// establishes for the real app.
const context = new Map<unknown, unknown>([["publicConfig", manager]]);

describe("ChatIntroduction SSR", () => {
	it("renders the name in the logo slot — the pick is client-only", () => {
		const { body } = render(ChatIntroduction, {
			props: { currentModel: model },
			context,
		});
		expect(body).toContain("chat-ui");
		for (const phrase of PHRASES) {
			expect(body).not.toContain(phrase);
		}
	});

	it("renders the name alone — no phrase slot the client would swap after paint", () => {
		const { body } = render(ChatIntroduction, {
			props: { currentModel: model },
			context,
		});
		// The slot is {#if phrase}/{:else}name: with the state starting empty
		// the server markup carries only the name, and the hydrated client
		// swaps the text in place — same node, same type, no layout shift.
		expect(body).toContain("chat-ui");
		for (const phrase of PHRASES) {
			expect(body).not.toContain(phrase);
		}
	});
});
