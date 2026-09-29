import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import CodeTasks from "./CodeTasks.svelte";
import { MessageUpdateType, type MessagePlanUpdate } from "$lib/types/MessageUpdate";
import type { PlanStep } from "$lib/types/Plan";

function plan(steps: PlanStep[]): MessagePlanUpdate {
	return {
		type: MessageUpdateType.Plan,
		uuid: "agent-plan-s1",
		goal: steps[0]?.step ?? "",
		version: 1,
		steps,
	};
}

const done = (n: number): PlanStep[] =>
	Array.from({ length: n }, (_, i) => ({ step: `finished ${i + 1}`, status: "completed" }));

describe("CodeTasks", () => {
	it("shows the count and a progress bar that agree", async () => {
		const screen = render(CodeTasks, {
			plan: plan([
				...done(3),
				{ step: "writing the view", status: "in_progress" },
				{ step: "ship", status: "pending" },
				{ step: "old idea", status: "skipped" },
				{ step: "docs", status: "pending" },
			]),
		});
		await expect.element(screen.getByTestId("tasks-count")).toHaveTextContent("3/7");
		const bar = screen.getByRole("progressbar");
		await expect.element(bar).toHaveAttribute("aria-valuenow", "3");
		await expect.element(bar).toHaveAttribute("aria-valuemax", "7");
	});

	it("highlights the in-progress item, strikes a cancelled one, badges only high priority", async () => {
		const screen = render(CodeTasks, {
			plan: plan([
				{ step: "working now", status: "in_progress", priority: "high" },
				{ step: "later", status: "pending", priority: "low" },
				{ step: "dropped", status: "skipped" },
			]),
		});
		const rows = screen.baseElement;
		const active = rows.querySelector('li[data-status="in_progress"]');
		expect(active?.className).toContain("font-medium");
		expect(rows.querySelector('li[data-status="skipped"]')?.className).toContain("line-through");
		expect(rows.querySelector('li[data-status="pending"]')?.className).not.toContain(
			"line-through"
		);
		// One badge, on the high-priority row only.
		expect(rows.querySelectorAll('[data-testid="priority-high"]')).toHaveLength(1);
		expect(active?.querySelector('[data-testid="priority-high"]')).not.toBeNull();
	});

	it("groups completed items, open while the list is short", async () => {
		const screen = render(CodeTasks, {
			plan: plan([...done(3), { step: "next", status: "pending" }]),
		});
		const toggle = screen.getByRole("button", { name: "Completed (3)" });
		await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
		await expect.element(screen.getByText("finished 1")).toBeVisible();
		await toggle.click();
		await expect.element(screen.getByText("finished 1")).not.toBeInTheDocument();
	});

	it("folds the completed group once the list passes eight, and unfolds on click", async () => {
		const screen = render(CodeTasks, {
			plan: plan([
				...done(6),
				{ step: "a", status: "pending" },
				{ step: "b", status: "pending" },
				{ step: "c", status: "pending" },
			]),
		});
		const toggle = screen.getByRole("button", { name: "Completed (6)" });
		await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
		await expect.element(screen.getByText("finished 1")).not.toBeInTheDocument();
		// The open items are never folded away.
		await expect.element(screen.getByText("a", { exact: true })).toBeVisible();
		await toggle.click();
		await expect.element(screen.getByText("finished 1")).toBeVisible();
	});

	it("says so when there is no list yet", async () => {
		const screen = render(CodeTasks, { plan: null });
		await expect
			.element(screen.getByTestId("tasks-empty"))
			.toHaveTextContent("No task list yet — the agent makes one with its todo tool.");
		expect(screen.baseElement.querySelector('[role="progressbar"]')).toBeNull();
	});
});
