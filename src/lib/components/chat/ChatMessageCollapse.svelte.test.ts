import { describe, it, expect } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import ChatMessage from "./ChatMessage.svelte";

const mount = (content: string) =>
	renderWithApp(ChatMessage, {
		message: { id: "m1", children: [], from: "user", content },
		isAuthor: true,
		readOnly: false,
	} as never);

describe("a long user message", () => {
	it("is folded behind Show more, and Show less folds it back", async () => {
		const view = mount(Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n"));
		const more = view.getByRole("button", { name: "Show more" });
		await expect.element(more).toBeVisible();
		await more.click();
		await expect.element(view.getByRole("button", { name: "Show less" })).toBeVisible();
		await view.getByRole("button", { name: "Show less" }).click();
		await expect.element(view.getByRole("button", { name: "Show more" })).toBeVisible();
	});

	it("a short one has no toggle", async () => {
		const view = mount("just a question");
		await expect.element(view.getByText("just a question")).toBeVisible();
		expect(view.baseElement.querySelector("button[aria-expanded]")).toBeNull();
	});
});
