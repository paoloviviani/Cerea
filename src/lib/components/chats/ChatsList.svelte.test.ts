/**
 * Deleting a chat from the `/chats` list: the row's `⋯` menu offers Delete,
 * the same confirmation modal the sidebar's row menu opens stands between the
 * click and the request, and a confirmed delete takes the row out and tells
 * the sidebar's store.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import superjson from "superjson";

import ChatsList from "./ChatsList.svelte";
import { renderWithApp } from "../__tests__/renderWithApp";
import { CONVERSATIONS_CONTEXT_KEY, newConversationsStore } from "$lib/stores/conversations.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const ROWS = [
	{ id: "a1", title: "Budget talk", model: "m", updatedAt: new Date().toISOString() },
	{ id: "a2", title: "Trip plan", model: "m", updatedAt: new Date().toISOString() },
];

interface SeenCall {
	method: string;
	url: string;
}

const text = () => document.body.textContent ?? "";

/** Open a row's `⋯` menu the way a pointer does, and return the item named `name`. */
async function menuItem(rowTitle: string, name: string): Promise<HTMLElement> {
	const trigger = document.body.querySelector(
		`[aria-label="Actions for ${rowTitle}"]`
	) as HTMLElement;
	if (!trigger) throw new Error(`no menu for ${rowTitle}`);
	trigger.dispatchEvent(
		new PointerEvent("pointerdown", {
			button: 0,
			bubbles: true,
			cancelable: true,
			pointerType: "mouse",
		})
	);
	let item: HTMLElement | undefined;
	await vi.waitFor(() => {
		item = [...document.body.querySelectorAll('[role="menuitem"]')].find((el) =>
			el.textContent?.includes(name)
		) as HTMLElement | undefined;
		if (!item) throw new Error(`no menu item ${name}`);
	});
	return item as HTMLElement;
}

describe("ChatsList delete", () => {
	let seen: SeenCall[];

	beforeEach(() => {
		seen = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				if (url.includes("/api/v2/projects")) return Response.json({ data: [] });
				if (/\/api\/v2\/conversations\/[^/]+$/.test(url) && method === "DELETE") {
					seen.push({ method, url });
					return new Response(superjson.stringify({ success: true }));
				}
				if (/\/api\/v2\/conversations\/[^/]+$/.test(url)) {
					return new Response("nope", { status: 404 });
				}
				return new Response(superjson.stringify({ conversations: ROWS, hasMore: false }));
			})
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.body.innerHTML = "";
	});

	it("deletes from the row menu after the confirmation, and tells the sidebar", async () => {
		const convsStore = newConversationsStore();
		convsStore.init([
			{ id: "a1", title: "Budget talk", updatedAt: new Date() },
			{ id: "a2", title: "Trip plan", updatedAt: new Date() },
		]);
		renderWithApp(ChatsList, {} as never, {
			context: new Map<unknown, unknown>([[CONVERSATIONS_CONTEXT_KEY, convsStore]]),
		});
		await vi.waitFor(() => expect(text()).toContain("Budget talk"));

		(await menuItem("Budget talk", "Delete")).click();
		// The confirmation the sidebar's row menu opens, before anything is sent.
		await vi.waitFor(() => expect(text()).toContain("Delete chat"));
		expect(seen).toHaveLength(0);

		const confirm = [...document.body.querySelectorAll("button")].find(
			(b) =>
				b.textContent?.trim() === "Delete" && (b.checkVisibility?.() ?? b.offsetParent !== null)
		) as HTMLButtonElement;
		expect(confirm).not.toBeUndefined();
		confirm.click();

		await vi.waitFor(() => expect(seen).toHaveLength(1));
		expect(seen[0].url).toMatch(/\/api\/v2\/conversations\/a1$/);
		await vi.waitFor(() => expect(text()).not.toContain("Budget talk"));
		expect(text()).toContain("Trip plan");
		expect(convsStore.list.some((conv) => String(conv.id) === "a1")).toBe(false);
	});

	it("leaves the row alone when the confirmation is cancelled", async () => {
		renderWithApp(ChatsList, {} as never);
		await vi.waitFor(() => expect(text()).toContain("Budget talk"));

		(await menuItem("Budget talk", "Delete")).click();
		await vi.waitFor(() => expect(text()).toContain("Delete chat"));
		const cancel = [...document.body.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Cancel"
		) as HTMLButtonElement;
		cancel.click();
		await vi.waitFor(() => expect(text()).not.toContain("Delete chat"));
		expect(seen).toHaveLength(0);
		expect(text()).toContain("Budget talk");
	});
});
