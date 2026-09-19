/**
 * The Memory tab: the person's facts with add/edit/delete, the per-user
 * opt-in switch beside the list it governs, and the budget marks showing
 * which rows are no longer sent to the model.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { writable } from "svelte/store";

import MemoryManager from "./MemoryManager.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import type { MemoryView } from "$lib/types/Memory";

let memories: MemoryView[] = [];
let calls: { url: string; method: string; body?: unknown }[] = [];
let nextId = 3;

function fact(id: string, text: string, source: "user" | "model" = "user"): MemoryView {
	return {
		id,
		text,
		source,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
	};
}

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				body: init?.body ? (JSON.parse(init.body) as unknown) : undefined,
			});
			if (url.endsWith("/api/v2/memory")) {
				if (method === "POST") {
					const parsed = JSON.parse(init?.body as string) as { text: string };
					const created = fact(`69${String(nextId++).padStart(22, "0")}`, parsed.text, "user");
					memories.push(created);
					return Response.json({ data: created }, { status: 201 });
				}
				return Response.json({ data: { memories, enabled: true } });
			}
			const match = url.match(/\/api\/v2\/memory\/([0-9a-f]{24})$/);
			if (match) {
				const row = memories.find((entry) => entry.id === match[1]);
				if (!row) return new Response("null", { status: 404 });
				if (method === "PATCH") {
					const parsed = JSON.parse(init?.body as string) as { text: string };
					row.text = parsed.text;
					return Response.json({ data: row });
				}
				if (method === "DELETE") {
					memories = memories.filter((entry) => entry.id !== row.id);
					return new Response(null, { status: 204 });
				}
			}
			return new Response("null", { status: 404 });
		})
	);
}

function settingsContext(enabled: boolean) {
	return {
		context: new Map<unknown, unknown>([["settings", writable({ memoryEnabled: enabled })]]),
	};
}

describe("MemoryManager", () => {
	beforeEach(() => {
		memories = [fact("691111111111111111111111", "Prefers concise answers.")];
		calls = [];
		nextId = 3;
		installFetch();
		renderWithApp(MemoryManager, {}, settingsContext(true));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("lists the stored facts with who added them", async () => {
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).not.toHaveLength(0)
		);
		expect(page.getByText("You added this").elements()).not.toHaveLength(0);
		expect(page.getByText("1 memory", { exact: false }).elements()).not.toHaveLength(0);
	});

	it("adds a fact through the API and appends it to the list", async () => {
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).not.toHaveLength(0)
		);
		await page.getByRole("button", { name: "Add memory" }).first().click();
		await vi.waitFor(() => expect(document.querySelector("#memory-draft")).not.toBeNull());
		const box = document.querySelector("#memory-draft") as HTMLInputElement;
		box.value = "Speaks Italian.";
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await page.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() =>
			expect(page.getByText("Speaks Italian.").elements()).not.toHaveLength(0)
		);
		expect(
			calls.some(
				(call) =>
					call.method === "POST" &&
					call.url.endsWith("/api/v2/memory") &&
					(call.body as { text?: string } | undefined)?.text === "Speaks Italian."
			)
		).toBe(true);
	});

	it("edits a fact in place through the API", async () => {
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).not.toHaveLength(0)
		);
		await page.getByRole("button", { name: "Edit" }).click();
		const boxes = document.querySelectorAll("input");
		const box = [...boxes].find(
			(entry) => entry.value === "Prefers concise answers."
		) as HTMLInputElement;
		box.value = "Prefers long answers.";
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await page.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() =>
			expect(page.getByText("Prefers long answers.").elements()).not.toHaveLength(0)
		);
		expect(
			calls.some(
				(call) =>
					call.method === "PATCH" &&
					call.url.endsWith("/api/v2/memory/691111111111111111111111") &&
					(call.body as { text?: string } | undefined)?.text === "Prefers long answers."
			)
		).toBe(true);
	});

	it("deletes a fact through the API and removes its row", async () => {
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).not.toHaveLength(0)
		);
		await page.getByRole("button", { name: "Delete" }).click();
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).toHaveLength(0)
		);
		expect(
			calls.some(
				(call) =>
					call.method === "DELETE" && call.url.endsWith("/api/v2/memory/691111111111111111111111")
			)
		).toBe(true);
	});

	it("shows the off notice — and that nothing is sent — when the switch is off", async () => {
		document.body.innerHTML = "";
		renderWithApp(MemoryManager, {}, settingsContext(false));
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).not.toHaveLength(0)
		);
		// The stored facts stay visible; the switch state says they are inert.
		expect(page.getByText("Off — nothing is being remembered or used").elements()).not.toHaveLength(
			0
		);
		expect(page.getByText("Memory is off.", { exact: false }).elements()).not.toHaveLength(0);
		// The switch itself follows the setting: unchecked here…
		const box = document.querySelector('input[name="memoryEnabled"]') as HTMLInputElement;
		expect(box.checked).toBe(false);
	});

	it("reflects an enabled setting on the switch", async () => {
		await vi.waitFor(() =>
			expect(page.getByText("Prefers concise answers.").elements()).not.toHaveLength(0)
		);
		const box = document.querySelector('input[name="memoryEnabled"]') as HTMLInputElement;
		expect(box.checked).toBe(true);
	});

	it("marks the rows past the prompt budget as no longer sent", async () => {
		// Twenty ~100-character facts cannot all fit the 1500-character
		// block, so the oldest must be marked — with the same arithmetic the
		// server builds the block from.
		memories = Array.from({ length: 20 }, (_, index) =>
			fact(`69${String(index).padStart(22, "0")}`, `Memory fact number ${index}. ` + "x".repeat(80))
		);
		document.body.innerHTML = "";
		renderWithApp(MemoryManager, {}, settingsContext(true));
		await vi.waitFor(() => expect(page.getByText("No longer sent").elements()).not.toHaveLength(0));
		expect(page.getByText("too old to fit", { exact: false }).elements()).not.toHaveLength(0);
	});
});
