import { describe, it, expect, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-svelte";
import MobileNav from "$lib/components/MobileNav.svelte";
import AgentHeaderRow, { type PaneItem } from "./AgentHeaderRow.svelte";
import type { CodeTurnState } from "$lib/types/CodeAgent";

const ITEMS: PaneItem[] = [
	{ id: "tasks", word: "Tasks", label: "Tasks 1/3", badge: "1/3", title: "t", pressed: false },
	{ id: "diff", word: "Changes", label: "Changes", badge: "3", title: "c", pressed: false },
	{ id: "files", word: "Files", label: "Files", title: "f", pressed: false },
	{
		id: "terminal",
		word: "Terminal",
		label: "Terminal",
		title: "Terminals are off.",
		pressed: false,
		disabled: true,
		reason: "Terminals are off.",
	},
];

function mount(over: Record<string, unknown> = {}) {
	const state = (over.state ?? "done") as CodeTurnState;
	return render(AgentHeaderRow, {
		name: "cloud_sync",
		turnState: state,
		stateLabel: {
			done: "done",
			running: "running",
			"waiting-permission": "Waiting for you",
			error: "error",
			idle: "idle",
		}[state],
		engine: "opencode",
		items: ITEMS,
		onselect: () => {},
		phone: false,
		...over,
	});
}

describe("AgentHeaderRow status", () => {
	it.each([
		["done", "bg-green-500"],
		["running", "bg-blue-500"],
	] as const)("%s is a labelled dot, with no status word", async (state, colour) => {
		const screen = mount({ state });
		const dot = screen.getByRole("img", { name: state });
		await expect.element(dot).toBeVisible();
		expect(dot.element().className).toContain(colour);
		expect(dot.element().getAttribute("title")).toBe(state);
		expect(screen.getByTestId("status-word").elements()).toHaveLength(0);
	});

	it.each([
		["waiting-permission", "Waiting for you", "bg-amber-500"],
		["error", "error", "bg-red-500"],
	] as const)("%s spells out its word", async (state, word, colour) => {
		const screen = mount({ state });
		await expect.element(screen.getByTestId("status-word")).toHaveTextContent(word);
		expect(screen.getByTestId("status-word").element().innerHTML).toContain(colour);
	});

	it("does not show the engine in the header", async () => {
		const screen = mount();
		expect(screen.getByText("opencode").elements()).toHaveLength(0);
	});
});

describe("AgentHeaderRow panels", () => {
	it("on a phone folds the panels behind one button and lists them in a sheet", async () => {
		await page.viewport(390, 800);
		const onselect = vi.fn();
		const screen = mount({ phone: true, onselect });
		render(MobileNav, { title: "" });
		expect(screen.getByRole("button", { name: "Files", exact: true }).elements()).toHaveLength(0);
		await screen.getByRole("button", { name: "Panels" }).click();

		await expect.element(screen.getByRole("button", { name: "Tasks 1/3" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Changes 3" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Files" })).toBeVisible();
		// The engine moves into the sheet header.
		await expect.element(screen.getByText("opencode · done")).toBeVisible();

		const terminal = screen.getByRole("button", { name: "Terminal" });
		await expect.element(terminal).toBeDisabled();
		await expect.element(screen.getByText("Terminals are off.").first()).toBeVisible();

		await screen.getByRole("button", { name: "Changes 3" }).click();
		expect(onselect).toHaveBeenCalledWith("diff");
		await expect.element(screen.getByTestId("panels-sheet")).not.toBeInTheDocument();
	});

	it("keeps the labelled buttons inline when they fit, and folds when they do not", async () => {
		await page.viewport(1200, 800);
		const screen = mount();
		const row = screen.getByTestId("agent-header").element() as HTMLElement;
		row.style.width = "900px";
		await expect.element(screen.getByRole("button", { name: "Files" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Panels" }).elements()).toHaveLength(0);

		row.style.width = "300px";
		await expect.element(screen.getByRole("button", { name: "Panels" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Files" }).elements()).toHaveLength(0);

		row.style.width = "900px";
		await expect.element(screen.getByRole("button", { name: "Files" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Panels" }).elements()).toHaveLength(0);
	});
});

describe("AgentHeaderRow in the phone top bar", () => {
	it("puts the name, dot and Panels button in the one top bar, with no row of its own", async () => {
		await page.viewport(390, 800);
		const screen = mount({ phone: true, state: "waiting-permission" });
		render(MobileNav, { title: "" });
		const bar = page.getByRole("navigation").first().element() as HTMLElement;
		const header = bar.querySelector("[data-testid=agent-header]") as HTMLElement;
		expect(header).not.toBeNull();
		expect(header.textContent).toContain("cloud_sync");
		expect(header.textContent).toContain("Waiting for you");
		expect(bar.querySelector("[data-testid=panels-button]")).not.toBeNull();
		// The hamburger and the new-chat link stay in the same bar.
		expect(bar.querySelector("button[aria-label]")).not.toBeNull();
		expect(bar.querySelector("a[href]")).not.toBeNull();
		// Nothing renders outside the bar.
		expect(screen.getByTestId("agent-header").elements()).toHaveLength(1);
		expect(header.closest("nav")).toBe(bar);
	});

	it("keeps the status dot's label and title, and the Panels sheet opens from the bar", async () => {
		await page.viewport(390, 800);
		mount({ phone: true, state: "done" });
		render(MobileNav, { title: "" });
		const dot = page.getByRole("img", { name: "done" });
		await expect.element(dot).toBeVisible();
		expect(dot.element().getAttribute("title")).toBe("done");
		await page.getByRole("button", { name: "Panels" }).click();
		await expect.element(page.getByTestId("panels-sheet")).toBeVisible();
	});

	it("truncates a long name instead of pushing the buttons out of the bar", async () => {
		await page.viewport(320, 700);
		mount({ phone: true, name: "a".repeat(200) });
		render(MobileNav, { title: "" });
		const bar = page.getByRole("navigation").first().element() as HTMLElement;
		const panels = bar.querySelector("[data-testid=panels-button]") as HTMLElement;
		expect(panels.getBoundingClientRect().right).toBeLessThanOrEqual(
			bar.getBoundingClientRect().right
		);
		expect(bar.scrollWidth).toBeLessThanOrEqual(bar.clientWidth);
	});

	it("leaves the desktop layout as one inline row, with the top bar hidden", async () => {
		await page.viewport(1200, 800);
		const screen = mount({ phone: undefined });
		render(MobileNav, { title: "" });
		const row = screen.getByTestId("agent-header").element() as HTMLElement;
		expect(row.closest("nav")).toBeNull();
		expect(row.textContent).toContain("cloud_sync");
	});

	it("gives the slot back when the row goes away", async () => {
		await page.viewport(390, 800);
		const screen = mount({ phone: true });
		render(MobileNav, { title: "" });
		await expect.element(page.getByTestId("panels-button")).toBeVisible();
		screen.unmount();
		await expect.element(page.getByTestId("panels-button")).not.toBeInTheDocument();
	});
});
