/**
 * The row `⋯` menu outside the sidebar: Delete is offered only when the
 * caller can delete, and selecting it calls `ondelete` and nothing else —
 * the caller owns the confirmation, the same modal the sidebar's row menu
 * opens.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-svelte";

import MoveMenu from "./MoveMenu.svelte";

const LABEL = "Holiday plans";

const itemNames = () =>
	[...document.body.querySelectorAll('[role="menuitem"]')].map(
		(el) => el.textContent?.trim() ?? ""
	);

/** Open the menu the way a pointer does (the trigger opens on pointerdown). */
async function open() {
	const trigger = document.body.querySelector(`[aria-label="Actions for ${LABEL}"]`) as HTMLElement;
	expect(trigger).not.toBeNull();
	trigger.dispatchEvent(
		new PointerEvent("pointerdown", {
			button: 0,
			bubbles: true,
			cancelable: true,
			pointerType: "mouse",
		})
	);
	await vi.waitFor(() => {
		if (itemNames().length === 0) throw new Error("the menu did not open");
	});
}

let unmount: (() => void) | undefined;
afterEach(() => {
	unmount?.();
	unmount = undefined;
	document.body.innerHTML = "";
});

describe("MoveMenu delete", () => {
	it("is not offered when the caller passes no ondelete", async () => {
		const screen = render(MoveMenu, { label: LABEL, onmove: () => {}, onremove: () => {} });
		unmount = screen.unmount;
		await open();
		expect(itemNames()).toEqual(["Move to project…", "Remove from project"]);
	});

	it("is the last item, in the destructive tint, and calls ondelete alone on select", async () => {
		const onmove = vi.fn();
		const onremove = vi.fn();
		const ondelete = vi.fn();
		const screen = render(MoveMenu, { label: LABEL, onmove, onremove, ondelete });
		unmount = screen.unmount;
		await open();
		expect(itemNames()).toEqual(["Move to project…", "Remove from project", "Delete"]);
		const del = [...document.body.querySelectorAll('[role="menuitem"]')].find(
			(el) => el.textContent?.trim() === "Delete"
		) as HTMLElement;
		expect(del.className).toContain("text-red-500");
		del.click();
		await vi.waitFor(() => expect(ondelete).toHaveBeenCalledTimes(1));
		expect(onmove).not.toHaveBeenCalled();
		expect(onremove).not.toHaveBeenCalled();
	});

	it("is offered alone when it is the only action", async () => {
		const screen = render(MoveMenu, { label: LABEL, ondelete: () => {} });
		unmount = screen.unmount;
		await open();
		expect(itemNames()).toEqual(["Delete"]);
	});
});
