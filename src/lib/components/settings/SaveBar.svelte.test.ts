import { describe, expect, it, vi } from "vitest";
import SaveBar from "./SaveBar.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

describe("SaveBar", () => {
	it("is absent while nothing is unsaved, and says Unsaved changes · Discard · Save when something is", async () => {
		const clean = renderWithApp(SaveBar, { dirty: false, form: "f" });
		expect(clean.getByTestId("save-bar").elements()).toHaveLength(0);
		clean.unmount();

		const ondiscard = vi.fn();
		const dirty = renderWithApp(SaveBar, { dirty: true, form: "f", ondiscard });
		await expect.element(dirty.getByText("Unsaved changes")).toBeVisible();
		await dirty.getByTestId("save-bar-discard").click();
		expect(ondiscard).toHaveBeenCalledTimes(1);
		const save = dirty.getByTestId("save-bar-save").element() as HTMLButtonElement;
		expect(save.textContent?.trim()).toBe("Save");
		// It submits the page's form.
		expect(save.getAttribute("form")).toBe("f");
		expect(save.type).toBe("submit");
	});

	it("is disabled while busy or when a required field is empty, and shows the busy label", async () => {
		const empty = renderWithApp(SaveBar, { dirty: true, form: "f", saveDisabled: true });
		expect((empty.getByTestId("save-bar-save").element() as HTMLButtonElement).disabled).toBe(true);
		empty.unmount();
		const busy = renderWithApp(SaveBar, {
			dirty: true,
			form: "f",
			busy: true,
			busyLabel: "Saving…",
		});
		const button = busy.getByTestId("save-bar-save").element() as HTMLButtonElement;
		expect(button.disabled).toBe(true);
		expect(button.textContent?.trim()).toBe("Saving…");
	});

	it("says Saved after a save, with no buttons, and a create form has no Discard", async () => {
		const saved = renderWithApp(SaveBar, { dirty: false, saved: true, form: "f" });
		await expect.element(saved.getByText("Saved")).toBeVisible();
		expect(saved.getByTestId("save-bar-save").elements()).toHaveLength(0);
		saved.unmount();

		const create = renderWithApp(SaveBar, {
			dirty: true,
			quiet: true,
			form: "f",
			saveLabel: "Create project",
		});
		expect(create.getByTestId("save-bar-discard").elements()).toHaveLength(0);
		expect(create.getByText("Unsaved changes").elements()).toHaveLength(0);
		expect(create.getByTestId("save-bar-save").element().textContent?.trim()).toBe(
			"Create project"
		);
	});

	it("docked is a footer bar with only the button, shown while there is something to create", async () => {
		const docked = renderWithApp(SaveBar, {
			dirty: true,
			docked: true,
			form: "f",
			saveLabel: "Create project",
		});
		const bar = docked.getByTestId("save-bar").element() as HTMLElement;
		expect(bar.getAttribute("data-docked")).toBe("true");
		expect(bar.className).toContain("sticky");
		expect(bar.className).not.toContain("rounded-full");
		expect(docked.getByText("Unsaved changes").elements()).toHaveLength(0);
		expect(
			(docked.getByTestId("save-bar-save").element() as HTMLButtonElement).textContent
		).toContain("Create project");
	});
});
