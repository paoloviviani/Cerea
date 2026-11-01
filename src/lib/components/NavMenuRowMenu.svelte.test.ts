import NavMenu from "./NavMenu.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { ACTIVE_GENERATIONS_CONTEXT_KEY } from "$lib/stores/activeGenerations.svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const DAY = 86_400_000;
const chat = (id: string, title: string, ageMs: number) => ({
	id,
	title,
	updatedAt: new Date(Date.now() - ageMs),
});

describe("the sidebar row menu keeps its chat when the list re-sorts", () => {
	let host: HTMLElement;

	beforeEach(() => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ conversations: [] }))
		);
		host = document.createElement("div");
		host.id = "app";
		document.body.appendChild(host);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		host.remove();
	});

	it("deletes the chat the menu was opened on, and the confirmation names it", async () => {
		const deleted: string[] = [];
		const props = (conversations: ReturnType<typeof chat>[]) =>
			({
				conversations,
				user: { username: "ada" },
				gatewayIsAdmin: false,
				ondeleteConversation: (id: string) => deleted.push(id),
			}) as never;
		const before = [
			chat("a", "Alpha chat", 1_000),
			chat("b", "Bravo chat", 2_000),
			chat("x", "Xray chat", 3 * DAY),
			chat("z", "Zulu chat", 4 * DAY),
		];
		const view = renderWithApp(NavMenu, props(before), {
			page: { data: { models: [] } },
			baseElement: host,
			context: new Map<unknown, unknown>([[ACTIVE_GENERATIONS_CONTEXT_KEY, { has: () => false }]]),
		});

		// Open the menu on the Xray row (it sits low, in an older group).
		const row = [...host.querySelectorAll("a")].find((a) => a.textContent?.includes("Xray chat"))
			?.parentElement as HTMLElement;
		const trigger = row.querySelector('button[aria-label="Chat actions"]') as HTMLElement;
		await page.elementLocator(trigger).click();
		await expect.element(page.getByText("Delete", { exact: true })).toBeVisible();

		// The list re-sorts: Xray was just chatted in and jumps to the top, into
		// another date group, while the menu is open.
		await view.rerender(
			props([
				chat("x", "Xray chat", 10),
				chat("a", "Alpha chat", 1_000),
				chat("b", "Bravo chat", 2_000),
				chat("z", "Zulu chat", 4 * DAY),
			])
		);

		await page.getByText("Delete", { exact: true }).click();
		// The confirmation shows the title of the chat that will be deleted.
		const dialogText = () => document.body.textContent ?? "";
		await vi.waitFor(() => expect(dialogText()).toContain("Xray chat"));
		const confirm = page.getByRole("button", { name: "Delete", exact: true });
		await confirm.last().click();

		expect(deleted).toEqual(["x"]);
	});
});
