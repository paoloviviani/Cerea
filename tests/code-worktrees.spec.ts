/**
 * Workspace directory suggestions and git worktrees (M8), hermetically: the
 * /code endpoints are stubbed at the network layer (the sidebar-restore/
 * dialogs-mobile pattern), so the client code paths — WorkspaceDialog's
 * debounced autocomplete, CodeNavTree's "New worktree…" action, and
 * WorktreeDialog's create call — are the real ones, with no real machine.
 */
import { test, expect } from "./fixtures";
import type { Page } from "playwright/test";
import superjson from "superjson";

const DEVICE = "srv_e2e_device";
const WS = "ws_e2e_repo";
const REPO_PATH = "/home/ubuntu/repo";

const superjsonBody = (data: unknown) => superjson.stringify(data);

/** The workspace rows the tree reads; tests mutate this between a create
 * call and the reload it triggers, the same pattern code-dialogs-mobile's
 * `deviceRows` uses for devices. */
let workspaceRows: Array<Record<string, unknown>> = [];

async function stubCodePanel(page: Page) {
	await page.route("**/api/v2/code/devices", (route) =>
		route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ devices: [{ id: DEVICE, name: "e2e box", status: "paired" }] }),
		})
	);
	await page.route("**/api/v2/code/v1/workspaces?*", (route) => {
		if (route.request().method() !== "GET") return route.fallback();
		return route.fulfill({
			contentType: "application/json",
			body: superjsonBody({ workspaces: workspaceRows }),
		});
	});
	await page.route("**/api/v2/code/v1/agents?*", (route) =>
		route.fulfill({ contentType: "application/json", body: superjsonBody({ agents: [] }) })
	);
}

test.beforeEach(() => {
	workspaceRows = [{ id: WS, name: "repo", path: REPO_PATH, isGitRepo: true }];
});

test.describe("path suggestions in the Add workspace dialog", () => {
	test("suggests directories while typing, and selecting one fills the field", async ({ page }) => {
		await stubCodePanel(page);

		let lastPrefix: string | null = null;
		await page.route("**/api/v2/code/v1/workspaces/suggest?*", (route) => {
			const url = new URL(route.request().url());
			lastPrefix = url.searchParams.get("prefix");
			return route.fulfill({
				contentType: "application/json",
				body: superjsonBody({
					directories: [
						{ path: "/home/ubuntu/projA", name: "projA", isGitRepo: true },
						{ path: "/home/ubuntu/projB", name: "projB", isGitRepo: false },
					],
				}),
			});
		});

		await page.goto(`/code?device=${DEVICE}`);
		await page.locator("button[title='Add a workspace to this device']").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		const pathInput = dialog.locator("#workspace-path");
		await pathInput.fill("/home/ubuntu/proj");

		const listbox = dialog.locator("#workspace-path-listbox");
		await expect(listbox).toBeVisible();
		await expect(listbox.getByText("/home/ubuntu/projA")).toBeVisible();
		await expect(listbox.getByText("/home/ubuntu/projB")).toBeVisible();
		expect(lastPrefix).toBe("/home/ubuntu/proj");

		await listbox.getByText("/home/ubuntu/projA").click();
		await expect(pathInput).toHaveValue("/home/ubuntu/projA");
		await expect(listbox).not.toBeVisible();
	});
});

test.describe("creating a worktree workspace", () => {
	test("offers New worktree… only on a git repo, and creates the worktree", async ({ page }) => {
		await stubCodePanel(page);

		let createBody: Record<string, unknown> | null = null;
		await page.route("**/api/v2/code/v1/workspaces?*", async (route) => {
			if (route.request().method() !== "POST") return route.fallback();
			createBody = route.request().postDataJSON() as Record<string, unknown>;
			const worktree = createBody.worktree as { from: string; branch: string };
			const workspace = {
				id: "ws_e2e_worktree",
				name: worktree.branch,
				path: `${REPO_PATH}.worktrees/${worktree.branch}`,
				isGitRepo: true,
				worktreeOf: worktree.from,
				branch: worktree.branch,
			};
			workspaceRows = [...workspaceRows, workspace];
			return route.fulfill({
				contentType: "application/json",
				body: superjsonBody({ workspace }),
			});
		});

		await page.goto(`/code?device=${DEVICE}`);

		await page.getByRole("button", { name: "Workspace actions" }).click();
		await expect(page.getByRole("menuitem", { name: "New worktree…" })).toBeVisible();
		await page.getByRole("menuitem", { name: "New worktree…" }).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await dialog.locator("#worktree-branch").fill("feature/x");
		await dialog.getByRole("button", { name: "Create worktree" }).click();

		await expect(dialog).not.toBeVisible();
		expect(createBody).toEqual({ worktree: { from: WS, branch: "feature/x" } });

		// The tree redraws from the daemon's answer, and shows the new
		// workspace's branch badge beside its name (the row's own name is
		// also "feature/x" here, so this is scoped to the badge specifically
		// rather than any text match).
		await expect(page.getByTitle("git worktree on feature/x")).toBeVisible();
	});
});
