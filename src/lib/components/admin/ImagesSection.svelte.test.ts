import ImagesSection from "./ImagesSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];

const status = {
	model: "flux-2-klein-4b",
	source: "first-available",
	stored_model: null,
	env_model: null,
	available_models: ["flux-2-klein-4b", "z-image-turbo"],
	account_available: true,
	account_reason: null,
	ask_first: false,
};

function stub(state: Record<string, unknown> = status) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			if (init?.method === "PUT") {
				const sent = JSON.parse(String(init.body));
				return Response.json({ ...state, stored_model: sent.model, ask_first: sent.ask_first });
			}
			return Response.json(state);
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration -> Assistant -> Images", () => {
	it("shows the model in use, the choices and whether the account can use it", async () => {
		stub();
		renderWithApp(ImagesSection, {});
		await expect.element(page.getByRole("heading", { name: "Images" })).toBeVisible();
		await expect
			.element(page.getByTestId("images-model-state"))
			.toHaveTextContent("flux-2-klein-4b");
		await expect
			.element(page.getByTestId("images-account-state"))
			.toHaveTextContent("Available to your account: yes");
		await expect.element(page.getByRole("option", { name: "z-image-turbo" })).toBeInTheDocument();
	});

	it("says why the account cannot use it, and when no image model exists", async () => {
		stub({
			...status,
			model: null,
			available_models: [],
			account_available: false,
			account_reason: "no_model",
		});
		renderWithApp(ImagesSection, {});
		await expect
			.element(page.getByTestId("images-model-state"))
			.toHaveTextContent(/no image model/i);
		await expect
			.element(page.getByTestId("images-account-state"))
			.toHaveTextContent("Available to your account: no");
	});

	it("saves the chosen model and the approval switch in one PUT", async () => {
		stub();
		renderWithApp(ImagesSection, {});
		await expect.element(page.getByTestId("image-ask-first")).toBeVisible();
		await page.getByTestId("image-model").selectOptions("z-image-turbo");
		await page.getByTestId("image-ask-first").click();
		await page.getByTestId("save-images").click();
		const put = calls.find((call) => call.init?.method === "PUT");
		expect(put?.url).toContain("/api/v2/admin/images");
		expect(JSON.parse(String(put?.init?.body))).toEqual({
			model: "z-image-turbo",
			ask_first: true,
		});
		await expect.element(page.getByText("Image settings saved.")).toBeVisible();
	});

	it("keeps Save off until something changes", async () => {
		stub();
		renderWithApp(ImagesSection, {});
		await expect.element(page.getByTestId("save-images")).toBeDisabled();
	});
});
