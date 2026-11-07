import { describe, expect, it, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import NavConversationItem from "./NavConversationItem.svelte";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";

const context = new Map<unknown, unknown>([[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false }]]);
const conv = { id: "c1", title: "Weekly notes", updatedAt: new Date() };

describe("NavConversationItem and scheduled runs", () => {
	it("marks a chat a scheduled run answered in, until it is the one open", async () => {
		const unread = renderWithApp(
			NavConversationItem,
			{ conv: { ...conv, unread: true } } as never,
			{ page: { params: { id: "other" }, data: {} }, context }
		);
		await expect.element(unread.getByTestId("unread-dot")).toBeVisible();
		unread.unmount();

		const open = renderWithApp(NavConversationItem, { conv: { ...conv, unread: true } } as never, {
			page: { params: { id: "c1" }, data: {} },
			context,
		});
		expect(open.getByTestId("unread-dot").elements()).toHaveLength(0);
		open.unmount();

		const read = renderWithApp(NavConversationItem, { conv } as never, {
			page: { params: { id: "other" }, data: {} },
			context,
		});
		expect(read.getByTestId("unread-dot").elements()).toHaveLength(0);
	});
});

describe("NavConversationItem Regenerate title", () => {
	async function openMenu(props: Record<string, unknown>) {
		const screen = renderWithApp(NavConversationItem, { conv, ...props } as never, {
			page: { params: { id: "other" }, data: {} },
			context,
		});
		await screen.getByRole("button", { name: "Chat actions" }).click();
		return screen;
	}

	it("is in the menu, and asks for the chat's title to be written again", async () => {
		const onregenerateTitle = vi.fn();
		const screen = await openMenu({ onregenerateTitle });
		await screen.getByRole("menuitem", { name: "Regenerate title" }).click();
		expect(onregenerateTitle).toHaveBeenCalledWith("c1");
	});

	it("is not offered on a title the user typed", async () => {
		const screen = await openMenu({
			conv: { ...conv, titleByUser: true },
			onregenerateTitle: vi.fn(),
		});
		await expect.element(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "Regenerate title" }).elements()).toHaveLength(0);
	});

	it("is not offered where nothing can act on it", async () => {
		const screen = await openMenu({});
		await expect.element(screen.getByRole("menuitem", { name: "Rename" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "Regenerate title" }).elements()).toHaveLength(0);
	});
});

describe("NavConversationItem sizes", () => {
	async function rowAt(width: number) {
		await browserPage.viewport(width, 800);
		const screen = renderWithApp(NavConversationItem, { conv } as never, {
			page: { params: { id: "other" }, data: {} },
			context,
		});
		const link = screen.getByText("Weekly notes").element().closest("a") as HTMLElement;
		return link.parentElement as HTMLElement;
	}

	it("steps the title down one size and tightens the row on a phone", async () => {
		const row = await rowAt(390);
		expect(getComputedStyle(row).fontSize).toBe("16px");
		expect(row.getBoundingClientRect().height).toBe(36);
	});

	it("leaves the desktop size and row height alone", async () => {
		const row = await rowAt(1200);
		expect(getComputedStyle(row).fontSize).toBe("15px");
		expect(row.getBoundingClientRect().height).toBe(32);
	});
});
