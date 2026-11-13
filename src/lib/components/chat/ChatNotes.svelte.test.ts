/** The chat's notes in the side panel: list, add, edit, delete, undo, and the count the entry button shows. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import ChatNotes from "./ChatNotes.svelte";
import { chatNotes } from "$lib/stores/chatNotes.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

type Note = { id: string; text: string; source: "model" | "user" };
let notes: Note[];
let calls: { method: string; url: string; body?: unknown }[];

beforeEach(() => {
	notes = [{ id: "n1", text: "Use metric units.", source: "model" }];
	calls = [];
	chatNotes.set(0);
	let next = 2;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			calls.push({ method, url, body });
			const id = url.split("/memory/")[1];
			if (method === "GET") return Response.json({ data: { notes } });
			if (method === "POST") {
				const note = { id: `n${next++}`, text: body.text, source: "user" as const };
				notes = [...notes, note];
				return Response.json({ data: note }, { status: 201 });
			}
			if (method === "PATCH") {
				notes = notes.map((n) => (n.id === id ? { ...n, text: body.text } : n));
				return Response.json({ data: notes.find((n) => n.id === id) });
			}
			notes = notes.filter((n) => n.id !== id);
			return new Response(null, { status: 204 });
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const text = () => document.body.textContent ?? "";
const button = (label: RegExp) =>
	[...document.querySelectorAll("button")].find((b) =>
		label.test((b.getAttribute("aria-label") ?? b.textContent ?? "").trim())
	) as HTMLButtonElement;

describe("ChatNotes", () => {
	it("lists the chat's notes with their count and who wrote them, and publishes the count", async () => {
		renderWithApp(ChatNotes, { conversationId: "c1" });
		await vi.waitFor(() => expect(text()).toContain("Use metric units."));
		expect(text()).toContain("Notes (1)");
		expect(text()).toContain("Added by the assistant");
		expect(chatNotes.count).toBe(1);
		expect(calls[0]).toMatchObject({
			method: "GET",
			url: expect.stringContaining("/conversations/c1/memory"),
		});
	});

	it("adds a note", async () => {
		renderWithApp(ChatNotes, { conversationId: "c1" });
		await vi.waitFor(() => expect(text()).toContain("Use metric units."));
		const input = document.querySelector("input[type=text]") as HTMLInputElement;
		await userEvent.fill(input, "Answer in French.");
		await userEvent.click(button(/^Add$/));
		await vi.waitFor(() => expect(text()).toContain("Answer in French."));
		expect(text()).toContain("Added by you");
		expect(chatNotes.count).toBe(2);
	});

	it("edits and deletes a note", async () => {
		renderWithApp(ChatNotes, { conversationId: "c1" });
		await vi.waitFor(() => expect(text()).toContain("Use metric units."));
		await userEvent.click(button(/Edit note/));
		const area = document.querySelector("textarea") as HTMLTextAreaElement;
		await userEvent.fill(area, "Use imperial units.");
		await userEvent.click(button(/^Save$/));
		await vi.waitFor(() => expect(text()).toContain("Use imperial units."));
		await userEvent.click(button(/Delete note/));
		await vi.waitFor(() => expect(text()).not.toContain("Use imperial units."));
		expect(text()).toContain("No notes yet.");
		expect(chatNotes.count).toBe(0);
	});

	it("undoes the last change: a delete brings the note back, an add removes it", async () => {
		renderWithApp(ChatNotes, { conversationId: "c1" });
		await vi.waitFor(() => expect(text()).toContain("Use metric units."));
		expect(button(/^Undo$/)).toBeUndefined();
		await userEvent.click(button(/Delete note/));
		await vi.waitFor(() => expect(text()).toContain("No notes yet."));
		await userEvent.click(button(/^Undo$/));
		await vi.waitFor(() => expect(text()).toContain("Use metric units."));

		const input = document.querySelector("input[type=text]") as HTMLInputElement;
		await userEvent.fill(input, "Temporary.");
		await userEvent.click(button(/^Add$/));
		await vi.waitFor(() => expect(text()).toContain("Temporary."));
		await userEvent.click(button(/^Undo$/));
		await vi.waitFor(() => expect(text()).not.toContain("Temporary."));
	});

	it("says it plainly when the notes cannot be loaded", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({ message: "Memory is not turned on here." }, { status: 404 })
			)
		);
		renderWithApp(ChatNotes, { conversationId: "c1" });
		await vi.waitFor(() => expect(text()).toContain("Memory is not turned on here."));
	});
});
