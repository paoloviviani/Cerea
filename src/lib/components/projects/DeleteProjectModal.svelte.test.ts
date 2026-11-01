import { describe, expect, it, vi } from "vitest";
import DeleteProjectModal from "./DeleteProjectModal.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

const project = (over = {}) => ({
	name: "Grant",
	hasMemory: true,
	conversationCount: 4,
	shares: [],
	...over,
});

const text = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ");
const button = (el: Element, label: string) => {
	const b = [...el.querySelectorAll("button")].find((x) => x.textContent?.trim() === label);
	if (!b) throw new Error(`no ${label} button`);
	return b;
};

describe("DeleteProjectModal", () => {
	it("deletes by default: no keepChats, memory and count named", async () => {
		const ondelete = vi.fn().mockResolvedValue(undefined);
		const { baseElement } = renderWithApp(DeleteProjectModal, { project: project(), ondelete });
		expect(text(baseElement)).toContain("Delete the project “Grant”?");
		expect(text(baseElement)).toContain("Its chats (4)");
		expect(text(baseElement)).toContain("past-chats knowledge base");
		button(baseElement, "Delete").click();
		await vi.waitFor(() => expect(ondelete).toHaveBeenCalledWith(false));
	});

	it("the checkbox keeps the chats and changes the chats line", async () => {
		const ondelete = vi.fn().mockResolvedValue(undefined);
		const { baseElement } = renderWithApp(DeleteProjectModal, { project: project(), ondelete });
		const box = baseElement.querySelector<HTMLInputElement>("input[type=checkbox]");
		expect(box?.checked).toBe(false);
		box?.click();
		await vi.waitFor(() => expect(text(baseElement)).toContain("move back to your normal list"));
		button(baseElement, "Delete").click();
		await vi.waitFor(() => expect(ondelete).toHaveBeenCalledWith(true));
	});

	it("names the memory only with hasMemory, and members' chats only when shared", () => {
		const { baseElement } = renderWithApp(DeleteProjectModal, {
			project: project({ hasMemory: false, shares: [{ kind: "user", principal: "a@b" }] }),
			ondelete: vi.fn(),
		});
		expect(text(baseElement)).not.toContain("past-chats knowledge base");
		expect(text(baseElement)).toContain("Other users' chats");
		expect(text(baseElement)).not.toContain("Its chats (");
	});

	it("shows a failure inline and stays open", async () => {
		const onclose = vi.fn();
		const { baseElement } = renderWithApp(DeleteProjectModal, {
			project: project(),
			onclose,
			ondelete: vi.fn().mockRejectedValue(new Error("Could not delete it.")),
		});
		button(baseElement, "Delete").click();
		await vi.waitFor(() => expect(text(baseElement)).toContain("Could not delete it."));
		expect(onclose).not.toHaveBeenCalled();
	});
});
