/**
 * The Customize models tab: the global system prompt, and creating, editing
 * and deleting custom models.
 *
 * The component talks to `/api/v2/custom-models` with `fetch`, so the tests
 * script that and assert on the requests it makes, then on what is drawn.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { writable } from "svelte/store";
import { page } from "@vitest/browser/context";

import CustomModelsManager from "./CustomModelsManager.svelte";
import { appNavigation, renderWithApp } from "$lib/components/__tests__/renderWithApp";
import type { CustomModelView } from "$lib/types/CustomModel";

const MODELS = [
	{ id: "test/glm", displayName: "GLM 5.3 Flash" },
	{ id: "test/kimi", displayName: "Kimi K3" },
	// A custom model is listed in the chat's models too; it is not a base.
	{
		id: "custom:aaaaaaaaaaaaaaaaaaaaaaaa",
		displayName: "Menu helper",
		customBase: { id: "test/glm", displayName: "GLM 5.3 Flash" },
	},
];

const EXISTING: CustomModelView = {
	id: "custom:aaaaaaaaaaaaaaaaaaaaaaaa",
	name: "Menu helper",
	description: "Plans lunches",
	baseModelId: "test/glm",
	systemPrompt: "You plan menus.",
};

function settingsContext() {
	const store = writable<Record<string, unknown>>({
		activeModel: "test/glm",
		globalSystemPrompt: "",
	});
	const instantSet = vi.fn(async (patch: Record<string, unknown>) =>
		store.update((s) => ({ ...s, ...patch }))
	);
	return {
		instantSet,
		context: new Map<unknown, unknown>([
			["settings", { subscribe: store.subscribe, update: vi.fn(), instantSet }],
		]),
	};
}

type Call = { url: string; method: string; body?: Record<string, unknown> };

/** A fetch that records requests and answers the way the API does. */
function stubApi(handler: (call: Call) => Response | Promise<Response>) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const call = {
				url: String(url),
				method: init?.method ?? "GET",
				body: init?.body ? JSON.parse(init.body) : undefined,
			};
			calls.push(call);
			return handler(call);
		})
	);
	return calls;
}

function mount(customModels: CustomModelView[], extra: Record<string, unknown> = {}) {
	const { context, instantSet } = settingsContext();
	renderWithApp(CustomModelsManager, { models: MODELS, customModels, ...extra } as never, {
		context,
	});
	return { instantSet };
}

const cards = () => [...document.body.querySelectorAll('[data-testid="custom-model-card"]')];

describe("Customize models", () => {
	beforeEach(() => {
		appNavigation().invalidateAll.mockClear();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("saves the global system prompt through the settings store", async () => {
		stubApi(() => Response.json({}));
		const { instantSet } = mount([]);

		await page.getByRole("textbox", { name: "Global system prompt" }).fill("  Always be brief.  ");
		await page.getByRole("button", { name: "Save", exact: true }).click();

		await vi.waitFor(() =>
			expect(instantSet).toHaveBeenCalledWith({ globalSystemPrompt: "Always be brief." })
		);
		await expect.element(page.getByText("Saved")).toBeInTheDocument();
	});

	it("shows the empty state, with a way to start", async () => {
		stubApi(() => Response.json({}));
		mount([]);
		await expect.element(page.getByText("No custom models yet")).toBeInTheDocument();
		expect(cards()).toHaveLength(0);
	});

	it("creates a custom model: the form posts name, base, prompt and description, then lists it", async () => {
		const calls = stubApi((call) =>
			call.method === "POST"
				? Response.json(
						{
							data: {
								id: "custom:bbbbbbbbbbbbbbbbbbbbbbbb",
								name: "Reviewer",
								baseModelId: "test/kimi",
								systemPrompt: "You review code.",
								description: "Strict",
							},
						},
						{ status: 201 }
					)
				: Response.json({})
		);
		mount([]);

		await page.getByRole("button", { name: "New custom model" }).first().click();
		await page.getByLabelText("Name").fill("Reviewer");
		await page.getByLabelText("Base model").selectOptions("test/kimi");
		await page.getByLabelText("Description").fill("Strict");
		await page.getByLabelText("System prompt").fill("You review code.");
		await page.getByRole("button", { name: "Create custom model" }).click();

		await vi.waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
		const post = calls.find((c) => c.method === "POST");
		expect(post?.url).toBe("/api/v2/custom-models");
		expect(post?.body).toEqual({
			name: "Reviewer",
			baseModelId: "test/kimi",
			systemPrompt: "You review code.",
			description: "Strict",
		});

		// Back on the list, with the card showing its base; the chat's model
		// list is reloaded so the picker offers it.
		await vi.waitFor(() => expect(cards()).toHaveLength(1));
		expect(cards()[0].textContent).toContain("Reviewer");
		expect(cards()[0].textContent).toContain("based on Kimi K3");
		expect(appNavigation().invalidateAll).toHaveBeenCalled();
	});

	it("offers only catalogue models as a base, never another custom model", async () => {
		stubApi(() => Response.json({}));
		mount([EXISTING]);
		await page.getByRole("button", { name: "New custom model" }).first().click();
		const options = [
			...document.body.querySelectorAll<HTMLOptionElement>("#custom-model-base option"),
		].map((o) => o.textContent?.trim());
		expect(options).toEqual(["GLM 5.3 Flash", "Kimi K3"]);
	});

	it("keeps Create disabled until there is a name and a prompt, and shows the API's refusal", async () => {
		stubApi(() =>
			Response.json({ message: "You already have a custom model with that name." }, { status: 409 })
		);
		mount([]);
		await page.getByRole("button", { name: "New custom model" }).first().click();

		const create = page.getByRole("button", { name: "Create custom model" });
		await expect.element(create).toBeDisabled();
		await page.getByLabelText("Name").fill("Dupe");
		await page.getByLabelText("System prompt").fill("p");
		await expect.element(create).toBeEnabled();
		await create.click();

		await expect
			.element(page.getByRole("alert"))
			.toHaveTextContent("You already have a custom model with that name.");
		// Still on the form: nothing was lost.
		await expect.element(page.getByLabelText("Name")).toHaveValue("Dupe");
	});

	it("edits a custom model: PATCHes the changed fields and updates the card", async () => {
		const calls = stubApi((call) =>
			call.method === "PATCH"
				? Response.json({ data: { ...EXISTING, systemPrompt: "You plan dinners." } })
				: Response.json({})
		);
		mount([EXISTING]);

		await page.getByRole("button", { name: "Edit" }).click();
		await expect.element(page.getByLabelText("Name")).toHaveValue("Menu helper");
		await expect.element(page.getByLabelText("System prompt")).toHaveValue("You plan menus.");
		await page.getByLabelText("System prompt").fill("You plan dinners.");
		await page.getByRole("button", { name: "Save changes" }).click();

		await vi.waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
		const patch = calls.find((c) => c.method === "PATCH");
		expect(patch?.url).toBe("/api/v2/custom-models/custom:aaaaaaaaaaaaaaaaaaaaaaaa");
		expect(patch?.body).toMatchObject({ name: "Menu helper", systemPrompt: "You plan dinners." });
		await vi.waitFor(() => expect(cards()).toHaveLength(1));
	});

	it("deletes only after a confirmation, then drops the card", async () => {
		const calls = stubApi(() => new Response(null, { status: 204 }));
		mount([EXISTING]);

		await page.getByRole("button", { name: "Delete" }).click();
		// Nothing is sent by the first click.
		expect(calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
		await expect.element(page.getByText(/Chats on it move to its base model/)).toBeInTheDocument();
		await page.getByRole("button", { name: "Delete" }).click();

		await vi.waitFor(() =>
			expect(calls.find((c) => c.method === "DELETE")?.url).toBe(
				"/api/v2/custom-models/custom:aaaaaaaaaaaaaaaaaaaaaaaa"
			)
		);
		await vi.waitFor(() => expect(cards()).toHaveLength(0));
	});

	it("makes a custom model the default for new chats", async () => {
		stubApi(() => Response.json({}));
		const { instantSet } = mount([EXISTING]);
		await page.getByRole("button", { name: "Set as default" }).click();
		expect(instantSet).toHaveBeenCalledWith({ activeModel: EXISTING.id });
	});

	it("flags a model whose base is no longer available, and will not make it the default", async () => {
		stubApi(() => Response.json({}));
		mount([{ ...EXISTING, baseModelId: "retired/model" }]);
		await expect.element(page.getByText("retired/model is unavailable")).toBeInTheDocument();
		await expect.element(page.getByRole("button", { name: "Set as default" })).toBeDisabled();
	});

	it("opens straight onto a model's form from ?id=", async () => {
		stubApi(() => Response.json({}));
		mount([EXISTING], { initialId: EXISTING.id });
		await expect.element(page.getByLabelText("Name")).toHaveValue("Menu helper");
	});
});
