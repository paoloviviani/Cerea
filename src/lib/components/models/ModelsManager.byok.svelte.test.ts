/**
 * Gateway BYOK in the Models list: a "Your key" badge on a user's own-key model only, and the
 * "Your providers and models" link only for a user who holds the capability on a deployment that
 * serves the console.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page } from "@vitest/browser/context";

import ModelsManager from "./ModelsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const base = {
	displayName: "Model",
	description: "d",
	supportsTools: false,
	multimodal: false,
	supportsReasoning: false,
	supportsArtifacts: false,
};
const MODELS = [
	{ ...base, id: "my/home-llama", displayName: "Home llama", byok: true },
	{ ...base, id: "acme/plain", displayName: "Plain model" },
];

function mount(data: Record<string, unknown>) {
	const store = writable({ activeModel: "acme/plain" });
	const settings = {
		subscribe: store.subscribe,
		update: vi.fn(),
		instantSet: vi.fn(async () => {}),
	};
	renderWithApp(ModelsManager, { models: MODELS } as never, {
		context: new Map<unknown, unknown>([["settings", settings]]),
		page: { data } as never,
	});
}

describe("ModelsManager BYOK", () => {
	afterEach(() => {
		document.body.innerHTML = "";
	});

	it("badges only the own-key model, with the tooltip", async () => {
		mount({});
		await expect.element(page.getByText("Home llama")).toBeVisible();
		const badges = page.getByText("Your key").elements();
		expect(badges).toHaveLength(1);
		expect(badges[0].getAttribute("title")).toContain("Uses your own API key");
	});

	it("shows the link only with the capability and a served console", async () => {
		mount({ byokAllowed: true, consoleEnabled: true });
		const link = page.getByRole("link", { name: "Your providers and models" });
		await expect.element(link).toBeVisible();
		expect(link.element().getAttribute("href")).toBe("/console/me/providers");
		expect(link.element().getAttribute("target")).toBe("_blank");
	});

	it("hides the link without the capability or without a console", async () => {
		mount({ byokAllowed: false, consoleEnabled: true });
		await expect.element(page.getByText("Home llama")).toBeVisible();
		expect(page.getByText("Your providers and models").elements()).toHaveLength(0);
		document.body.innerHTML = "";
		mount({ byokAllowed: true, consoleEnabled: false });
		await expect.element(page.getByText("Home llama")).toBeVisible();
		expect(page.getByText("Your providers and models").elements()).toHaveLength(0);
	});
});
