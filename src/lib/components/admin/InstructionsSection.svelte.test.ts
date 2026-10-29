/**
 * The admin Assistant instructions page: load, the live count against the cap,
 * the visibility switch, save and revert, and the same at phone width.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import Page from "./InstructionsSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

type Call = { method: string; body?: { instructions: string; visible: boolean } };

function stubApi(initial = { instructions: "Be brief.", visible: true }, configurable = true) {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
			const method = init?.method ?? "GET";
			const body = init?.body ? JSON.parse(init.body) : undefined;
			calls.push({ method, body });
			if (method === "PUT") return Response.json(body);
			return Response.json({ ...initial, max: 4000, configurable });
		})
	);
	return calls;
}

const box = () => page.getByRole("textbox", { name: "Instructions" });

beforeEach(async () => {
	await page.viewport(1440, 900);
});
afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Assistant instructions (admin)", () => {
	it("shows the saved text, the explanation, a live count, and the switch on by default", async () => {
		stubApi();
		renderWithApp(Page, {});
		await expect.element(box()).toHaveValue("Be brief.");
		await expect
			.element(
				page.getByText(
					"Added to every chat's instructions, before each user's own. Not used by coding agents."
				)
			)
			.toBeVisible();
		await expect.element(page.getByText("9 of 4000 characters")).toBeVisible();
		await expect.element(page.getByLabelText("Show these instructions to users")).toBeChecked();

		await box().fill("Be brief and kind.");
		await expect.element(page.getByText("18 of 4000 characters")).toBeVisible();
	});

	it("saves the trimmed text and the switch, then reports it", async () => {
		const calls = stubApi();
		renderWithApp(Page, {});
		await expect.element(box()).toHaveValue("Be brief.");
		const save = page.getByRole("button", { name: "Save", exact: true });
		await expect.element(save).toBeDisabled();

		await box().fill("  Answer in Italian.  ");
		await page.getByLabelText("Show these instructions to users").click();
		await save.click();

		await vi.waitFor(() =>
			expect(calls.find((c) => c.method === "PUT")?.body).toEqual({
				instructions: "Answer in Italian.",
				visible: false,
			})
		);
		await expect.element(page.getByText(/Saved\./)).toBeVisible();
		await expect.element(save).toBeDisabled();
	});

	it("reverts unsaved edits, and refuses to save past the cap", async () => {
		const calls = stubApi();
		renderWithApp(Page, {});
		await expect.element(box()).toHaveValue("Be brief.");
		await box().fill("x".repeat(4001));
		await expect.element(page.getByText("4001 of 4000 characters")).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

		await page.getByRole("button", { name: "Revert" }).click();
		await expect.element(box()).toHaveValue("Be brief.");
		expect(calls.some((c) => c.method === "PUT")).toBe(false);
	});

	it("counts the trimmed text, like the server: padding is neither counted nor a reason to refuse", async () => {
		stubApi();
		renderWithApp(Page, {});
		await expect.element(box()).toHaveValue("Be brief.");
		await box().fill("  Be brief  ");
		await expect.element(page.getByText("8 of 4000 characters")).toBeVisible();

		await box().fill("x".repeat(4000) + "     ");
		await expect.element(page.getByText("4000 of 4000 characters")).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
	});

	it("works at 390px: no sideways scroll, and every control reachable", async () => {
		await page.viewport(390, 800);
		stubApi();
		renderWithApp(Page, {});
		await expect.element(box()).toHaveValue("Be brief.");
		await box().fill("Be brief and kind.");
		await expect.element(page.getByText("18 of 4000 characters")).toBeVisible();
		await expect.element(page.getByLabelText("Show these instructions to users")).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Revert" })).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
			document.documentElement.clientWidth
		);
	});
});
