/** An agent's notes in the code panel: two lists (session, workspace), editable and deletable by the owner. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "@vitest/browser/context";
import AgentNotes from "./AgentNotes.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

type Note = { id: string; text: string; source: "model" | "user" };
let store: Record<string, Note[]>;
let requests: string[];

beforeEach(() => {
	store = {
		"session:s1": [{ id: "a1", text: "Tests need the database.", source: "model" }],
		"workspace:w1": [{ id: "b1", text: "Use pnpm.", source: "user" }],
	};
	requests = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input), "http://x");
			const method = init?.method ?? "GET";
			requests.push(`${method} ${url.pathname}${url.search}`);
			const body = init?.body ? JSON.parse(String(init.body)) : undefined;
			const scope = url.searchParams.get("scope") ?? body?.scope;
			const key = url.searchParams.get("key") ?? body?.key;
			const list = (store[`${scope}:${key}`] ??= []);
			if (method === "GET") return Response.json({ data: { notes: list } });
			if (method === "POST") {
				const note = { id: `n${list.length + 9}`, text: body.text, source: "user" as const };
				list.push(note);
				return Response.json({ data: note }, { status: 201 });
			}
			const id = url.pathname.split("/").pop();
			if (method === "PATCH") {
				const found = list.find((n) => n.id === id);
				if (found) found.text = body.text;
				return Response.json({ data: found });
			}
			store[`${scope}:${key}`] = list.filter((n) => n.id !== id);
			return new Response(null, { status: 204 });
		})
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

const text = () => document.body.textContent ?? "";
function must<T>(value: T | null | undefined): T {
	if (value == null) throw new Error("expected element");
	return value;
}
const within = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement;

describe("AgentNotes", () => {
	it("shows the session's and the workspace's notes apart, labelled, with a warning that they are only notes", async () => {
		const oncount = vi.fn();
		renderWithApp(AgentNotes, { deviceId: "d1", sessionId: "s1", workspaceId: "w1", oncount });
		await vi.waitFor(() => expect(text()).toContain("Use pnpm."));
		expect(within("agent-notes-session").textContent).toContain("Tests need the database.");
		expect(within("agent-notes-session").textContent).not.toContain("Use pnpm.");
		expect(within("agent-notes-workspace").textContent).toContain("Use pnpm.");
		expect(text()).toContain("Written by the agent");
		expect(text()).toContain("Added by you");
		expect(text()).toMatch(/not as instructions/);
		expect(oncount).toHaveBeenLastCalledWith(2);
		// Nothing but the two agent scopes is ever asked for.
		for (const r of requests) expect(r).toMatch(/scope=(session|workspace)/);
	});

	it("adds, edits and deletes in the list it is in", async () => {
		renderWithApp(AgentNotes, { deviceId: "d1", sessionId: "s1", workspaceId: "w1" });
		await vi.waitFor(() => expect(text()).toContain("Use pnpm."));
		const ws = within("agent-notes-workspace");
		await userEvent.fill(
			ws.querySelector("input[type=text]") as HTMLInputElement,
			"Run lint first."
		);
		await userEvent.click(
			must([...ws.querySelectorAll("button")].find((b) => b.textContent === "Add"))
		);
		await vi.waitFor(() =>
			expect(within("agent-notes-workspace").textContent).toContain("Run lint first.")
		);
		expect(within("agent-notes-session").textContent).not.toContain("Run lint first.");

		const session = within("agent-notes-session");
		await userEvent.click(must(session.querySelector('button[aria-label="Edit note"]')));
		await userEvent.fill(must(session.querySelector("textarea")), "Tests need Postgres.");
		await userEvent.click(
			must([...session.querySelectorAll("button")].find((b) => b.textContent === "Save"))
		);
		await vi.waitFor(() =>
			expect(within("agent-notes-session").textContent).toContain("Tests need Postgres.")
		);

		await userEvent.click(
			must(within("agent-notes-session").querySelector('button[aria-label="Delete note"]'))
		);
		await vi.waitFor(() =>
			expect(within("agent-notes-session").textContent).toContain("No notes yet.")
		);
		expect(within("agent-notes-workspace").textContent).toContain("Use pnpm.");
	});

	it("offers no workspace list for a session that has no workspace id", async () => {
		renderWithApp(AgentNotes, { deviceId: "d1", sessionId: "s1" });
		await vi.waitFor(() => expect(text()).toContain("Tests need the database."));
		expect(within("agent-notes-workspace")).toBeNull();
	});
});
