/**
 * The Models dialog's "What it may do" switches, one per capability.
 *
 * Regression cover for the report that only one switch could be changed before
 * the rest stopped responding: every switch has to flip in both directions,
 * several in a row, inside a single dialog session.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page } from "@vitest/browser/context";

import ModelsManager from "./ModelsManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const MODEL = {
	id: "test/model",
	displayName: "Test Model",
	description: "A model for tests",
	supportsTools: true,
	multimodal: true,
	supportsReasoning: false,
	supportsArtifacts: false,
};

/** The slice of the layout's settings context the dialog reads and writes. */
function settingsContext() {
	const store = writable({
		activeModel: "test/model",
		multimodalOverrides: {},
		toolsOverrides: {},
		artifactsOverrides: {},
		reasoningOverrides: {},
	});
	const update = vi.fn((fn: (s: never) => never) => store.update(fn as never));
	const instantSet = vi.fn(async () => {});
	return {
		store,
		context: new Map<unknown, unknown>([
			["settings", { subscribe: store.subscribe, update, instantSet }],
		]),
	};
}

/** The visible switch control for one capability, found via its named input. */
function switchFor(name: string): HTMLElement {
	const input = document.body.querySelector(`input[name="${name}"]`);
	if (!input) throw new Error(`no switch input named ${name}`);
	const control = input.nextElementSibling;
	if (!(control instanceof HTMLElement)) throw new Error(`no switch control for ${name}`);
	return control;
}

/**
 * A person's click on one switch: Playwright drives a trusted pointer event,
 * which — unlike a synthetic `.click()` — also runs the wrapping label's
 * forwarded activation on the switch's hidden input.
 */
async function trustedFlip(name: string): Promise<void> {
	const switches = page.getByRole("switch");
	const count = switches.elements().length;
	for (let index = 0; index < count; index++) {
		const element = switches.nth(index).elements()[0];
		if (element?.previousElementSibling?.getAttribute("name") === name) {
			await switches.nth(index).click();
			return;
		}
	}
	throw new Error(`no switch control for ${name}`);
}

function mount() {
	const { context } = settingsContext();
	renderWithApp(
		ModelsManager,
		// Opened straight onto the one model, as a `?tab=models&id=…` deep link
		// does — the capability switches live in the detail view.
		{ models: [MODEL], initialId: MODEL.id } as never,
		{ context }
	);
}

describe("ModelsManager capability switches", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({}))
		);
		mount();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("starts each switch on the gateway's advertised value", async () => {
		await vi.waitFor(() => expect(switchFor("model-tools")).not.toBeNull());
		expect(switchFor("model-tools").getAttribute("aria-checked")).toBe("true");
		expect(switchFor("model-multimodal").getAttribute("aria-checked")).toBe("true");
		expect(switchFor("model-reasoning").getAttribute("aria-checked")).toBe("false");
		expect(switchFor("model-artifacts").getAttribute("aria-checked")).toBe("false");
	});

	it("flips a switch off and back on again", async () => {
		await vi.waitFor(() => expect(switchFor("model-tools")).not.toBeNull());

		await trustedFlip("model-tools");
		await vi.waitFor(() =>
			expect(switchFor("model-tools").getAttribute("aria-checked")).toBe("false")
		);

		await trustedFlip("model-tools");
		await vi.waitFor(() =>
			expect(switchFor("model-tools").getAttribute("aria-checked")).toBe("true")
		);
	});

	it("flips several switches in one session without blocking", async () => {
		await vi.waitFor(() => expect(switchFor("model-tools")).not.toBeNull());
		const flip = (name: string) => trustedFlip(name);

		await flip("model-tools");
		await vi.waitFor(() =>
			expect(switchFor("model-tools").getAttribute("aria-checked")).toBe("false")
		);

		await flip("model-multimodal");
		await vi.waitFor(() =>
			expect(switchFor("model-multimodal").getAttribute("aria-checked")).toBe("false")
		);

		await flip("model-reasoning");
		await vi.waitFor(() =>
			expect(switchFor("model-reasoning").getAttribute("aria-checked")).toBe("true")
		);

		await flip("model-artifacts");
		await vi.waitFor(() =>
			expect(switchFor("model-artifacts").getAttribute("aria-checked")).toBe("true")
		);
	});
});
