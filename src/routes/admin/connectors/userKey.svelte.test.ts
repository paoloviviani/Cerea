/**
 * The admin Connectors page, the mode where each user brings their own key: the form that
 * defines the connector (no key of its own), and the card that shows how many users have added
 * one (a count, never a key) and checks with a test key that is sent once.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { page } from "@vitest/browser/context";

import Page from "./+page.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const KEYED = {
	id: "c-keyed",
	key: "connector:c-keyed",
	enabled: true,
	name: "GitHub",
	url: "https://github.test/mcp",
	auth: "user-key",
	scope: "deployment",
	manageable: true,
	connected: false,
	canAuthorize: false,
	tokenHeader: "X-Api-Key",
	keyHelpText: "Create a token with the repo scope.",
	keyHelpUrl: "https://github.test/tokens",
	keyCount: 2,
	mode: "on",
	alwaysLoaded: false,
	updatedAt: new Date().toISOString(),
};

let posts: Array<{ url: string; body: Record<string, unknown> }>;

beforeEach(() => {
	posts = [];
	vi.unstubAllGlobals();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "POST" && url.includes("/api/v2/mcp/connectors")) {
				posts.push({ url, body: JSON.parse(String(init.body)) });
				return Response.json({});
			}
			if (url.includes("/api/mcp/servers")) return Response.json([]);
			if (url.includes("/api/v2/mcp/connectors")) return Response.json({ data: [KEYED] });
			return Response.json({});
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

describe("admin connectors: each user provides their own key", () => {
	it("defines the connector with a header and help, and sends no key", async () => {
		renderWithApp(Page, {} as never);
		await expect.element(page.getByText("GitHub", { exact: true })).toBeInTheDocument();
		await page.getByRole("button", { name: "Add", exact: true }).click();
		await page.getByLabelText("Name").fill("GitHub");
		await page.getByLabelText("URL").fill("https://github.test/mcp");
		const select = document.querySelector("select") as HTMLSelectElement;
		await page.elementLocator(select).selectOptions("user_key");

		// No key field and no "shared key" warning: the connector holds nothing.
		await expect.element(page.getByTestId("user-key-fields")).toBeInTheDocument();
		const form = document.querySelector('[data-testid="user-key-fields"]')?.closest("form");
		expect(form?.querySelector('input[type="password"]')).toBeNull();
		expect(form?.textContent).not.toContain("This key is shared");

		await page.getByLabelText("Header").fill("X-Api-Key");
		await page.getByLabelText("Help for users").fill("Create a token with the repo scope.");
		await page.getByLabelText("Link to create a key").fill("https://github.test/tokens");
		await page.getByRole("button", { name: "Add for everyone" }).click();
		await vi.waitFor(() =>
			expect(posts).toContainEqual({
				url: expect.stringContaining("/api/v2/mcp/connectors"),
				body: {
					name: "GitHub",
					url: "https://github.test/mcp",
					scope: "deployment",
					authMode: "user_key",
					tokenHeader: "X-Api-Key",
					keyHelpText: "Create a token with the repo scope.",
					keyHelpUrl: "https://github.test/tokens",
				},
			})
		);
		expect(JSON.stringify(posts)).not.toContain('"token"');
	});

	it("shows how many users added a key, never a key, and checks with a test key sent once", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("GitHub", { exact: true })).toBeInTheDocument();
		await expect
			.element(page.getByTestId("key-count"))
			.toHaveTextContent("2 users have added a key");
		expect(screen.baseElement.textContent).toContain("each user's own key");

		const testKey = screen.baseElement.querySelector('input[type="password"]') as HTMLInputElement;
		expect(testKey).not.toBeNull();
		await page.elementLocator(testKey).fill("ghp_test_only");
		await page.getByRole("button", { name: "Check", exact: true }).click();
		await vi.waitFor(() =>
			expect(posts).toContainEqual({
				url: expect.stringContaining("/api/v2/mcp/connectors/c-keyed?scope=deployment"),
				body: { action: "check", testKey: "ghp_test_only" },
			})
		);
		// Cleared once sent: it is not kept on the page.
		await vi.waitFor(() => expect(testKey.value).toBe(""));
	});

	it("edits the header and help without offering a shared key", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("GitHub", { exact: true })).toBeInTheDocument();
		[...screen.baseElement.querySelectorAll("button")]
			.find((b) => b.textContent?.trim() === "Edit")
			?.click();
		const form = (await vi.waitFor(() => {
			const found = screen.baseElement.querySelector('[data-testid="edit-user-key"]');
			expect(found).not.toBeNull();
			return found;
		})) as HTMLElement;
		expect(form.closest("form")?.querySelector('input[type="password"]')).toBeNull();
		await page.getByLabelText("Help for users").fill("Use a fine-grained token.");
		[...screen.baseElement.querySelectorAll("button")]
			.find((b) => b.textContent?.trim() === "Save changes")
			?.click();
		await vi.waitFor(() =>
			expect(posts).toContainEqual({
				url: expect.stringContaining("/api/v2/mcp/connectors/c-keyed?scope=deployment"),
				body: expect.objectContaining({
					action: "update",
					tokenHeader: "X-Api-Key",
					keyHelpText: "Use a fine-grained token.",
					keyHelpUrl: "https://github.test/tokens",
				}),
			})
		);
	});
});
