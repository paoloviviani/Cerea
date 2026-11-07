import { describe, it, expect, vi } from "vitest";
import { page } from "@vitest/browser/context";
import { render } from "vitest-browser-svelte";
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
