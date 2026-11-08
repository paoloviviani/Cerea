/** The past-chats index status, Reindex and Retry in the project settings. */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page } from "@vitest/browser/context";

import ProjectPastChatsIndex from "./ProjectPastChatsIndex.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import type { PastChatsIndex } from "$lib/types/Project";

const ROOT = "/api/v2/projects/691111111111111111111aaa/past-chats";
let state: PastChatsIndex & { canManage: boolean };
const MODELS = {
	embeddingModel: "bge-m3",
	embeddingChosen: false,
	models: ["bge-m3", "e5-large"],
	defaultModel: "bge-m3",
};
let calls: { url: string; method: string }[] = [];

beforeEach(() => {
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string }) => {
			const method = init?.method ?? "GET";
			calls.push({ url, method });
			if (method === "POST") {
				state = { ...state, state: "indexed", indexed: 3, failed: 0, error: null };
			}
			return Response.json({ data: state });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

const mount = (shared = false) =>
	renderWithApp(ProjectPastChatsIndex, { projectId: "691111111111111111111aaa", shared });

describe("ProjectPastChatsIndex", () => {
	it("shows the friendly failure, and Retry then Reindex call the owner routes", async () => {
		state = {
			state: "failed",
			indexed: 2,
			indexing: 0,
			failed: 1,
			error: "Not indexed: the usage allowance had run out when this was indexed.",
			canManage: true,
			...MODELS,
		};
		mount();
		await expect.element(page.getByText("Failed (1)")).toBeVisible();
		await expect.element(page.getByText(/usage allowance had run out/)).toBeVisible();
		await page.getByRole("button", { name: "Retry" }).click();
		await expect.element(page.getByText("Indexed (3)")).toBeVisible();
		expect(calls.at(-1)).toEqual({ url: `${ROOT}/retry`, method: "POST" });
		expect(page.getByRole("button", { name: "Retry" }).elements()).toHaveLength(0);
		await page.getByRole("button", { name: "Reindex" }).click();
		expect(calls.at(-1)).toEqual({ url: ROOT, method: "POST" });
	});

	it("offers no buttons to a user who cannot manage the project", async () => {
		state = {
			state: "indexed",
			indexed: 5,
			indexing: 0,
			failed: 0,
			error: null,
			canManage: false,
			...MODELS,
		};
		mount();
		await expect.element(page.getByText("Indexed (5)")).toBeVisible();
		expect(page.getByRole("button").elements()).toHaveLength(0);
	});

	it("changes the embedder after an inline confirm, through the reindex route", async () => {
		state = {
			state: "indexed",
			indexed: 3,
			indexing: 0,
			failed: 0,
			error: null,
			canManage: true,
			...MODELS,
		};
		const bodies: unknown[] = [];
		const inner = fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
				if (init?.body) bodies.push(JSON.parse(init.body));
				return inner(url, init as never);
			})
		);
		mount();
		await expect.element(page.getByText("Indexed (3)")).toBeVisible();
		await page.getByRole("combobox").selectOptions("e5-large");
		await expect
			.element(page.getByText("Changing the embedder reindexes all 3 documents."))
			.toBeVisible();
		expect(bodies).toEqual([]);
		await page.getByRole("button", { name: "Change and reindex" }).click();
		await expect.poll(() => bodies).toEqual([{ embedding_model: "e5-large" }]);
	});

	it("shows the model as text to a member who cannot manage", async () => {
		state = {
			state: "indexed",
			indexed: 5,
			indexing: 0,
			failed: 0,
			error: null,
			canManage: false,
			...MODELS,
		};
		mount();
		await expect.element(page.getByText("bge-m3")).toBeVisible();
		expect(page.getByRole("combobox").elements()).toHaveLength(0);
	});

	it("says not indexed, with Reindex disabled", async () => {
		state = {
			state: "none",
			indexed: 0,
			indexing: 0,
			failed: 0,
			error: null,
			canManage: true,
			...MODELS,
			embeddingModel: null,
		};
		mount();
		await expect.element(page.getByText("Not indexed")).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Reindex" })).toBeDisabled();
	});

	it("warns in a shared project that members without the chosen model do not take part", async () => {
		state = {
			state: "indexed",
			indexed: 2,
			indexing: 0,
			failed: 0,
			error: null,
			canManage: true,
			...MODELS,
			embeddingChosen: true,
			embeddingModel: "e5-large",
		};
		mount(true);
		await expect
			.element(page.getByText(/Members who can't use this model won't add their chats/))
			.toBeVisible();
	});
});
