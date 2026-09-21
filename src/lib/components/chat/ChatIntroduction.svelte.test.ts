import ChatIntroduction from "./ChatIntroduction.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, it, expect, vi } from "vitest";
import type { Model } from "$lib/types/Model";

/**
 * The rotating phrase beside the app name on the new-chat screen: one of
 * the configured list per load, nothing when the deployment set "false" —
 * and nothing on the server, where a random pick would hydration-mismatch
 * against a different client pick.
 */

const model = { id: "m", displayName: "Model", name: "model" } as unknown as Model;

const PHRASES = ["Com'è?", "Va bin", "Facciamo che iniziare?", "Oh basta là"];

describe("ChatIntroduction", () => {
	it("prints one of the configured phrases beside the name", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: `"${PHRASES.join(",")}"` } }
		);
		// The phrase is picked in onMount (post-hydration), so wait for one
		// of the four to appear.
		await vi.waitFor(() => {
			const printed = PHRASES.filter((phrase) => screen.baseElement.textContent?.includes(phrase));
			expect(printed).toHaveLength(1);
		});
	});

	it('restores the plain name when the deployment sets "false"', async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: "false" } }
		);
		await vi.waitFor(() => expect(screen.getByText("chat-ui")).toBeVisible());
		for (const phrase of PHRASES) {
			expect(screen.baseElement.textContent).not.toContain(phrase);
		}
	});

	it("restores the plain name when the variable is empty", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: "" } }
		);
		await vi.waitFor(() => expect(screen.getByText("chat-ui")).toBeVisible());
		for (const phrase of PHRASES) {
			expect(screen.baseElement.textContent).not.toContain(phrase);
		}
	});

	it("ignores an invalid JSON array rather than guessing (misconfiguration degrades to the plain name)", async () => {
		const screen = renderWithApp(
			ChatIntroduction,
			{ currentModel: model },
			{ publicConfig: { PUBLIC_TURIN_PHRASES: '["Com\'è?",' } }
		);
		await vi.waitFor(() => expect(screen.getByText("chat-ui")).toBeVisible());
		expect(screen.baseElement.textContent).not.toContain("Com'è?");
	});
});
