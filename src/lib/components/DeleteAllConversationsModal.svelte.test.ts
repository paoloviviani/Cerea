import DeleteAllConversationsModal from "./DeleteAllConversationsModal.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { describe, expect, it, vi } from "vitest";

describe("DeleteAllConversationsModal", () => {
	it("renders when open and displays description noting project chats are kept", () => {
		const { baseElement } = renderWithApp(DeleteAllConversationsModal, { open: true });

		const heading = baseElement.querySelector("h2");
		expect(heading?.textContent?.trim()).toBe("Delete all conversations");

		const normalizedText = (baseElement.textContent ?? "").replace(/\s+/g, " ");
		expect(normalizedText).toContain("Chats inside projects are deleted too");
		expect(normalizedText).toContain("This action cannot be undone");
	});

	it("does not render when open is false", () => {
		const { baseElement } = renderWithApp(DeleteAllConversationsModal, { open: false });
		expect(baseElement.querySelector("h2")).toBeNull();
	});

	it("calls onclose when Cancel button is clicked", async () => {
		const onclose = vi.fn();
		const { baseElement } = renderWithApp(DeleteAllConversationsModal, {
			open: true,
			onclose,
		});

		const cancel = [...baseElement.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Cancel"
		);
		if (!cancel) throw new Error("no cancel button");
		cancel.click();

		expect(onclose).toHaveBeenCalledTimes(1);
	});

	it("calls ondelete when Delete all button is clicked", async () => {
		const ondelete = vi.fn();
		const { baseElement } = renderWithApp(DeleteAllConversationsModal, {
			open: true,
			ondelete,
		});

		const deleteBtn = [...baseElement.querySelectorAll("button")].find(
			(b) => b.textContent?.trim() === "Delete all"
		);
		if (!deleteBtn) throw new Error("no delete all button");
		deleteBtn.click();

		expect(ondelete).toHaveBeenCalledTimes(1);
	});
});
