import { describe, it, expect, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { createRawSnippet } from "svelte";
import { render } from "vitest-browser-svelte";
import SidePane from "./SidePane.svelte";
import { sidePane } from "$lib/stores/sidePane.svelte";

const children = createRawSnippet(() => ({
	render: () => `<div data-testid="view-body">the view</div>`,
}));
const actions = createRawSnippet(() => ({
	render: () => `<button type="button">Reload</button>`,
}));

function mount(props: Record<string, unknown> = {}) {
	sidePane.open = true;
	return render(SidePane, { label: "Tasks", children, ...props });
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(async () => {
	sidePane.reset();
	await browserPage.viewport(1200, 800);
});

describe("SidePane desktop frame", () => {
	it("is a labelled column with the wash, rounded edge and breathing gap", async () => {
		const screen = mount();
		const aside = screen.getByRole("complementary", { name: "Tasks" }).element();
		expect(aside.className).toContain("rounded-l-xl");
		expect(aside.className).toContain("bg-linear-to-r");
		expect(aside.className).toContain("my-1.5");
		await expect.element(screen.getByTestId("view-body")).toBeVisible();
		// No title, no frame header: the view owns its own (artifact panel).
		expect(screen.container.querySelector("[data-testid='side-pane-header']")).toBeNull();
	});

	it("draws a header on opt-in, with the title, the view's actions and a working close", async () => {
		const screen = mount({ title: "Changes", actions });
		const header = screen.getByTestId("side-pane-header");
		await expect.element(header).toHaveTextContent("Changes");
		await expect.element(screen.getByRole("button", { name: "Reload" })).toBeVisible();
		expect(header.element().getBoundingClientRect().height).toBe(44);
		await screen.getByRole("button", { name: "Close Tasks" }).click();
		expect(sidePane.open).toBe(false);
	});

	it("keeps the view's body fully inside the frame under the header", async () => {
		const screen = mount({ title: "Changes" });
		const aside = screen.getByRole("complementary").element().getBoundingClientRect();
		const body = screen.getByTestId("view-body").element().getBoundingClientRect();
		expect(body.top).toBeGreaterThanOrEqual(aside.top + 44);
		expect(body.bottom).toBeLessThanOrEqual(aside.bottom);
	});

	it("closes on Escape, except when escape is disabled or already consumed", async () => {
		mount();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(sidePane.open).toBe(false);

		sidePane.open = true;
		const consumed = new KeyboardEvent("keydown", { key: "Escape", cancelable: true });
		consumed.preventDefault();
		window.dispatchEvent(consumed);
		expect(sidePane.open).toBe(true);
	});

	it("ignores Escape while the view has disabled it", () => {
		mount({ escapeDisabled: true });
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));
		expect(sidePane.open).toBe(true);
	});

	it("opens at the default split — about a third of the window — until a drag overrides it", async () => {
		const screen = mount();
		const aside = screen.getByRole("complementary", { name: "Tasks" }).element() as HTMLElement;
		expect(aside.style.width).toBe("33vw");
		sidePane.setWidth(500);
		await tick();
		expect(aside.style.width).toBe("500px");
		sidePane.resetWidth();
		await tick();
		expect(aside.style.width).toBe("33vw");
	});

	it("resets a dragged width on double-click of the handle", async () => {
		const screen = mount();
		sidePane.setWidth(500);
		await tick();
		expect(sidePane.widthPx).toBe(500);
		const handle = screen.getByRole("separator").element();
		handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		expect(sidePane.widthPx).toBeNull();
	});

	it("shows the grip only on hover, and blue while dragging", async () => {
		const screen = mount();
		const grip = screen.getByTestId("side-pane-grip").element();
		expect(grip.className).toContain("opacity-0");
		expect(grip.className).toContain("group-hover:opacity-100");
		const handle = screen.getByRole("separator").element();
		handle.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
		await tick();
		expect(screen.getByTestId("side-pane-grip").element().className).toContain("bg-blue-500/60");
		handle.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
	});
});

describe("SidePane mobile drawer", () => {
	beforeEach(async () => {
		await browserPage.viewport(400, 800);
	});

	it("renders a dialog with a backdrop instead of the column, and closes on the backdrop", async () => {
		const screen = mount();
		await expect.element(screen.getByRole("dialog", { name: "Tasks" })).toBeVisible();
		expect(screen.container.querySelector("aside")).toBeNull();
		// The drawer covers the right 85%, so the backdrop's centre is under it:
		// tap the strip left of the drawer, where a person would. (Clicking the
		// centre only passed when it landed before the drawer had flown in.)
		await screen.getByRole("button", { name: "Close Tasks" }).click({ position: { x: 5, y: 5 } });
		expect(sidePane.open).toBe(false);
	});

	it("carries the same frame header, so a migrated view keeps its title and close", async () => {
		const screen = mount({ title: "Files", actions });
		await expect.element(screen.getByTestId("side-pane-header")).toHaveTextContent("Files");
		await expect.element(screen.getByRole("button", { name: "Reload" })).toBeVisible();
	});
});
