import TitleModelSection from "./TitleModelSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];

const status = {
	model: null,
	task_model: null,
	configurable: true,
	available_models: [
		{ id: "big-reasoner", name: "Big Reasoner", reasoning: true },
		{ id: "small-chat", name: "Small Chat", reasoning: false },
	],
};

function stub(state: Record<string, unknown> = status) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			if (init?.method === "PUT") {
				return Response.json({ ...state, model: JSON.parse(String(init.body)).model });
			}
			return Response.json(state);
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration -> Assistant -> Model for titles", () => {
	it("offers automatic and the chat models, marking the reasoning ones", async () => {
		stub();
		renderWithApp(TitleModelSection, {});
		await expect.element(page.getByRole("heading", { name: "Model for titles" })).toBeVisible();
		const select = page.getByTestId("title-model");
		await expect.element(select).toHaveValue("");
		await expect.element(page.getByRole("option", { name: "Automatic" })).toBeInTheDocument();
		await expect
			.element(page.getByRole("option", { name: "Big Reasoner (reasoning)" }))
			.toBeInTheDocument();
		await expect.element(page.getByRole("option", { name: "Small Chat" })).toBeInTheDocument();
	});

	it("saves the chosen model, and automatic as null", async () => {
		stub();
		renderWithApp(TitleModelSection, {});
		await expect.element(page.getByTestId("title-model")).toBeVisible();
		await page.getByTestId("title-model").selectOptions("small-chat");
		await page.getByTestId("save-title-model").click();
		await expect.poll(() => calls.some((c) => c.init?.method === "PUT")).toBe(true);
		const put = calls.find((c) => c.init?.method === "PUT");
		expect(put).toBeDefined();
		expect(put?.url).toContain("/api/v2/admin/title-model");
		expect(JSON.parse(String(put?.init?.body))).toEqual({ model: "small-chat" });
		await expect.element(page.getByText("Title model saved.")).toBeVisible();
	});

	it("is read-only when the deployment keeps configuration in the environment", async () => {
		stub({ ...status, configurable: false });
		renderWithApp(TitleModelSection, {});
		await expect.element(page.getByTestId("title-model")).toBeDisabled();
		await expect.element(page.getByTestId("save-title-model")).toBeDisabled();
	});
});
