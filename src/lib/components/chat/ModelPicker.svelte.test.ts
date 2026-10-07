/**
 * The per-chat model picker: search on top, slim rows, one choice.
 *
 * Cover for the picker's own redesign — narrower than the form overlays, the
 * search unconditional (a three-model deployment still gets it) and focused on
 * open, rows filtering live over name, id and description, and the empty
 * result in the app's dashed empty-state idiom. The active model keeps its
 * highlight, choosing still switches and closes, and Escape still closes the
 * overlay from inside the search (`Modal` owns Escape at window level).
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page } from "@vitest/browser/context";

import ModelPicker from "./ModelPicker.svelte";
import { renderWithApp, setPage } from "$lib/components/__tests__/renderWithApp";
import { CONVERSATIONS_CONTEXT_KEY } from "$lib/stores/conversations.svelte";

const MODELS = [
	{
		id: "test/llama-4",
		name: "Llama 4",
		displayName: "Llama 4 Maverick",
		description: "general chat",
	},
	{
		id: "test/qwen-coder",
		name: "Qwen Coder",
		displayName: "Qwen 3 Coder",
		description: "code specialist",
	},
	{
		id: "test/soot",
		name: "Soot",
		displayName: "Soot",
		description: "a tiny local model",
	},
];

/** The settings slice the picker writes on the new-chat screen. */
function settingsContext() {
	const store = writable({ activeModel: "test/llama-4" });
	const update = vi.fn((fn: (s: never) => never) => store.update(fn as never));
	const instantSet = vi.fn(async () => {});
	return {
		store,
		instantSet,
		context: new Map<unknown, unknown>([
			["settings", { subscribe: store.subscribe, update, instantSet }],
		]),
	};
}

function mount(onclose: () => void): { instantSet: ReturnType<typeof vi.fn> } {
	const { context, instantSet } = settingsContext();
	renderWithApp(ModelPicker, { models: MODELS, currentModel: MODELS[0], onclose } as never, {
		context: new Map<unknown, unknown>([
			...context,
			[CONVERSATIONS_CONTEXT_KEY, { refresh: vi.fn(async () => {}) }],
		]),
	});
	return { instantSet };
}

function rowNamed(text: string): HTMLButtonElement | null {
	return (
		[...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
			button.textContent?.includes(text)
		) ?? null
	);
}

function searchInput(): HTMLInputElement {
	const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Search models"]');
	if (!input) throw new Error("no search input");
	return input;
}

async function type(query: string): Promise<void> {
	await page.getByRole("searchbox").fill(query);
}

describe("ModelPicker", () => {
	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({}))
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("lists every model, highlights the current one, and opens with the search focused", async () => {
		const onclose = vi.fn();
		setPage({});
		mount(onclose);

		await vi.waitFor(() => expect(rowNamed("Llama 4 Maverick")).not.toBeNull());
		expect(rowNamed("Llama 4 Maverick")?.getAttribute("aria-current")).toBe("true");
		expect(rowNamed("Qwen 3 Coder")?.getAttribute("aria-current")).toBeNull();
		expect(rowNamed("Soot")).not.toBeNull();

		// The search is unconditional — a three-model deployment still gets it —
		// and it holds focus on open, not the dialog container.
		await vi.waitFor(() =>
			expect(document.activeElement?.getAttribute("aria-label")).toBe("Search models")
		);
	});

	it("filters live by name and description", async () => {
		const onclose = vi.fn();
		setPage({});
		mount(onclose);

		await vi.waitFor(() => expect(rowNamed("Llama 4 Maverick")).not.toBeNull());

		await type("qwen");
		expect(rowNamed("Qwen 3 Coder")).not.toBeNull();
		expect(rowNamed("Llama 4 Maverick")).toBeNull();

		await type("code specialist");
		expect(rowNamed("Qwen 3 Coder")).not.toBeNull();

		await type("soot");
		expect(rowNamed("Soot")).not.toBeNull();
	});

	it("shows the dashed empty state for a miss, and clearing restores the list", async () => {
		const onclose = vi.fn();
		setPage({});
		mount(onclose);

		await vi.waitFor(() => expect(rowNamed("Llama 4 Maverick")).not.toBeNull());

		await type("zzz");
		await vi.waitFor(() =>
			expect(document.body.querySelector('[class*="border-dashed"]')).not.toBeNull()
		);
		expect(document.body.textContent).toContain("No model matches that search.");
		expect(rowNamed("Llama 4 Maverick")).toBeNull();

		const clear = [...document.body.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Clear the search")
		);
		if (!clear) throw new Error("no clear button");
		clear.click();
		await vi.waitFor(() => expect(rowNamed("Llama 4 Maverick")).not.toBeNull());
	});

	it("choosing a model sets what the new chat starts on and closes", async () => {
		const onclose = vi.fn();
		setPage({});
		const { instantSet } = mount(onclose);

		await vi.waitFor(() => expect(rowNamed("Qwen 3 Coder")).not.toBeNull());
		rowNamed("Qwen 3 Coder")?.click();

		await vi.waitFor(() => expect(instantSet).toHaveBeenCalledTimes(1));
		expect(instantSet).toHaveBeenCalledWith({ activeModel: "test/qwen-coder" });
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it("closes on Escape from inside the search, as before", async () => {
		const onclose = vi.fn();
		setPage({ params: { id: "conv-1" } });
		mount(onclose);

		await vi.waitFor(() => expect(rowNamed("Llama 4 Maverick")).not.toBeNull());
		// Dispatched on the input, not on window: the point is that a keydown
		// arising inside the search reaches `Modal`'s handler. `Modal` owns
		// Escape twice over — a window-capture listener and the dialog's own
		// onkeydown — so one press can call onclose more than once; the parent's
		// close is idempotent and "closed" is the contract, not the call count.
		searchInput().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
		expect(onclose).toHaveBeenCalled();
	});
});

describe("ModelPicker with custom models", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("lists a custom model beside the base models, marked custom and naming its base", async () => {
		setPage({});
		const custom = {
			id: "custom:aaaaaaaaaaaaaaaaaaaaaaaa",
			name: "Menu helper",
			displayName: "Menu helper",
			description: "Plans lunches",
			customBase: { id: "test/llama-4", displayName: "Llama 4 Maverick" },
		};
		const { context } = settingsContext();
		renderWithApp(
			ModelPicker,
			{ models: [...MODELS, custom], currentModel: MODELS[0], onclose: vi.fn() } as never,
			{
				context: new Map<unknown, unknown>([
					...context,
					[CONVERSATIONS_CONTEXT_KEY, { refresh: vi.fn(async () => {}) }],
				]),
			}
		);

		await vi.waitFor(() => expect(rowNamed("Menu helper")).not.toBeNull());
		const row = rowNamed("Menu helper");
		// "Menu helper · Llama 4 Maverick", with the custom mark.
		expect(row?.textContent).toContain("Menu helper");
		expect(row?.textContent).toContain("· Llama 4 Maverick");
		expect(row?.textContent).toContain("custom");
		// The base models are right there with it, unmarked, and the custom id is not shown.
		expect(rowNamed("Qwen 3 Coder")?.textContent).not.toContain("custom");
		expect(row?.textContent).not.toContain("custom:aaaa");

		// Searching by the base's name finds the custom model too.
		await type("maverick");
		expect(rowNamed("Menu helper")).not.toBeNull();
		expect(rowNamed("Llama 4 Maverick")).not.toBeNull();
	});
});
