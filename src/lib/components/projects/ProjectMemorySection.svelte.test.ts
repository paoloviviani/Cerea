/**
 * The project overlay's Memory section: notes with their author and source
 * chat, add/edit/delete through the project's routes, and the marks on notes
 * past the prompt budget.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { page } from "@vitest/browser/context";

import ProjectMemorySection from "./ProjectMemorySection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import type { ProjectMemoryView } from "$lib/types/ProjectMemory";

const PROJECT = "691111111111111111111aaa";
const ROOT = `/api/v2/projects/${PROJECT}/memory`;

let notes: ProjectMemoryView[] = [];
let calls: { url: string; method: string; body?: { text?: string } }[] = [];
let nextId = 3;

function note(id: string, text: string, extra: Partial<ProjectMemoryView> = {}): ProjectMemoryView {
	return {
		id,
		text,
		source: "user",
		author: "Olga Owner",
		mine: false,
		createdAt: "2026-10-01T10:00:00.000Z",
		updatedAt: "2026-10-01T10:00:00.000Z",
		...extra,
	};
}

function installFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
			const method = init?.method ?? "GET";
			const body = init?.body ? (JSON.parse(init.body) as { text?: string }) : undefined;
			calls.push({ url, method, body });
			if (url.endsWith(ROOT)) {
				if (method === "POST") {
					const created = note(`69${String(nextId++).padStart(22, "0")}`, body?.text ?? "", {
						author: "Carlo Colleague",
						mine: true,
					});
					notes.push(created);
					return Response.json({ data: created }, { status: 201 });
				}
				return Response.json({ data: { notes } });
			}
			const match = url.match(/\/memory\/([0-9a-f]{24})$/);
			const row = match && notes.find((entry) => entry.id === match[1]);
			if (row && method === "PATCH") {
				row.text = body?.text ?? row.text;
				return Response.json({ data: row });
			}
			if (row && method === "DELETE") {
				notes = notes.filter((entry) => entry.id !== row.id);
				return new Response(null, { status: 204 });
			}
			return new Response("null", { status: 404 });
		})
	);
}

const shown = (text: string) => page.getByText(text, { exact: false }).elements().length > 0;

describe("ProjectMemorySection", () => {
	beforeEach(() => {
		notes = [
			note("691111111111111111111111", "Deploys go through the release branch."),
			note("691111111111111111111112", "Staging resets on Mondays.", {
				author: "deleted user",
				source: "model",
				conversationId: "691111111111111111119999",
			}),
		];
		calls = [];
		nextId = 3;
		installFetch();
		renderWithApp(ProjectMemorySection, { projectId: PROJECT });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("lists each note with its author, its date and the chat it came from", async () => {
		await vi.waitFor(() => expect(shown("Deploys go through the release branch.")).toBe(true));
		expect(shown("Added by Olga Owner")).toBe(true);
		// An erased author reads as "deleted user", and a model-written note links its chat.
		expect(shown("deleted user")).toBe(true);
		const link = document.querySelector('a[href$="/conversation/691111111111111111119999"]');
		expect(link).not.toBeNull();
		expect(shown("Project memory (2)")).toBe(true);
	});

	it("adds a note through the project's route and appends it as the viewer's own", async () => {
		await vi.waitFor(() => expect(shown("Staging resets on Mondays.")).toBe(true));
		await page.getByRole("button", { name: "Add note" }).first().click();
		await vi.waitFor(() => expect(document.querySelector("#project-memory-draft")).not.toBeNull());
		const box = document.querySelector("#project-memory-draft") as HTMLTextAreaElement;
		box.value = "Use the shared staging key vault.";
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await page.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() => expect(shown("Use the shared staging key vault.")).toBe(true));
		expect(shown("Added by you")).toBe(true);
		expect(
			calls.some(
				(call) =>
					call.method === "POST" &&
					call.url.endsWith(ROOT) &&
					call.body?.text === "Use the shared staging key vault."
			)
		).toBe(true);
	});

	it("edits and deletes any note, whoever wrote it", async () => {
		await vi.waitFor(() => expect(shown("Deploys go through the release branch.")).toBe(true));
		await page.getByRole("button", { name: "Edit" }).first().click();
		const box = document.querySelector('textarea[aria-label="Edit note"]') as HTMLTextAreaElement;
		box.value = "Deploys go through main.";
		box.dispatchEvent(new Event("input", { bubbles: true }));
		await page.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() => expect(shown("Deploys go through main.")).toBe(true));
		expect(
			calls.some(
				(call) =>
					call.method === "PATCH" &&
					call.url.endsWith(`${ROOT}/691111111111111111111111`) &&
					call.body?.text === "Deploys go through main."
			)
		).toBe(true);

		await page.getByRole("button", { name: "Delete" }).first().click();
		await vi.waitFor(() => expect(shown("Deploys go through main.")).toBe(false));
		expect(
			calls.some(
				(call) => call.method === "DELETE" && call.url.endsWith(`${ROOT}/691111111111111111111111`)
			)
		).toBe(true);
	});

	it("marks the notes past the prompt budget as no longer sent", async () => {
		// Six ~1,900-character notes exceed the 8,000-character block, so the
		// oldest two must be marked — with the arithmetic the server uses.
		notes = Array.from({ length: 6 }, (_, index) =>
			note(`69${String(index).padStart(22, "0")}`, `Long note ${index}. ` + "x".repeat(1900))
		);
		document.body.innerHTML = "";
		renderWithApp(ProjectMemorySection, { projectId: PROJECT });
		await vi.waitFor(() =>
			expect(page.getByText("No longer sent", { exact: true }).elements().length).toBe(2)
		);
		expect(shown("are no longer sent to the model")).toBe(true);
	});
});
