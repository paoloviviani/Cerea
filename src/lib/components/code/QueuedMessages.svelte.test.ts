import { describe, expect, it, vi } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import QueuedMessages from "./QueuedMessages.svelte";

describe("QueuedMessages", () => {
	it("shows nothing when no message is waiting", async () => {
		const { container } = renderWithApp(QueuedMessages, { queued: [], oncancel: vi.fn() });
		expect(container.querySelector('[data-testid="queued-messages"]')).toBeNull();
	});

	it("lists the waiting messages, oldest first, each cancellable by its id", async () => {
		const oncancel = vi.fn();
		renderWithApp(QueuedMessages, {
			queued: [
				{ id: "c2", text: "then run the tests" },
				{ id: "c3", text: "and the linter" },
			],
			oncancel,
		});
		await expect.element(browserPage.getByText("then run the tests")).toBeInTheDocument();
		await expect.element(browserPage.getByText("and the linter")).toBeInTheDocument();
		await browserPage.getByRole("button", { name: "Cancel this message" }).nth(1).click();
		expect(oncancel).toHaveBeenCalledWith("c3");
	});
});
