import { describe, expect, it } from "vitest";
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
