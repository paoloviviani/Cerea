import { describe, it, expect } from "vitest";
import { render } from "vitest-browser-svelte";
import BackgroundTaskCard from "./BackgroundTaskCard.svelte";
import { MessageUpdateType, type MessageBackgroundTaskUpdate } from "$lib/types/MessageUpdate";

function marker(overrides: Partial<MessageBackgroundTaskUpdate> = {}): MessageBackgroundTaskUpdate {
	return {
		type: MessageUpdateType.BackgroundTask,
		taskId: "ses_child1",
		callId: "call_task1",
		state: "running",
		summary: "Background task started: Survey the repo",
		...overrides,
	};
}

describe("BackgroundTaskCard", () => {
	it("names a running child and shows its summary, with no result to expand", async () => {
		const screen = render(BackgroundTaskCard, { update: marker() });
		await expect.element(screen.getByTestId("background-task-marker")).toBeVisible();
		await expect
			.element(screen.getByText("Running in the background", { exact: true }))
			.toBeVisible();
		await expect
			.element(screen.getByText("Background task started: Survey the repo", { exact: true }))
			.toBeVisible();
		expect(screen.baseElement.querySelector("button")).toBeNull();
	});

	it("marks an injected completion automatic and expands its result on click", async () => {
		const screen = render(BackgroundTaskCard, {
			update: marker({
				state: "completed",
				summary: "Background task completed: Survey the repo",
				text: "The repo holds a SvelteKit app.",
				automatic: true,
				callId: undefined,
			}),
		});
		await expect
			.element(screen.getByText("Background task finished", { exact: true }))
			.toBeVisible();
		await expect.element(screen.getByText("automatic", { exact: true })).toBeVisible();
		const toggle = screen.getByRole("button", { name: "Show the reported result" });
		await expect
			.element(screen.getByText("The repo holds a SvelteKit app."))
			.not.toBeInTheDocument();
		await toggle.click();
		await expect.element(screen.getByText("The repo holds a SvelteKit app.")).toBeVisible();
	});

	it("labels a task_id resume a follow-up and a failure as failed", async () => {
		const followUp = render(BackgroundTaskCard, {
			update: marker({ followUp: true }),
		});
		await expect.element(followUp.getByText("follow-up", { exact: true })).toBeVisible();

		const failed = render(BackgroundTaskCard, {
			update: marker({ state: "error", summary: "Background task failed: Survey the repo" }),
		});
		await expect.element(failed.getByText("Background task failed", { exact: true })).toBeVisible();
	});
});
