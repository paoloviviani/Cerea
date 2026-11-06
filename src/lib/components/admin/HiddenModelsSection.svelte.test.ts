import HiddenModelsSection from "./HiddenModelsSection.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { page } from "@vitest/browser/context";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const calls: { url: string; init?: RequestInit }[] = [];

const row = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	name: id,
	reasoning: false,
	hidden: false,
	env_unlisted: false,
	is_default: false,
	...extra,
});

const status = {
	configurable: true,
	models: [row("big", { is_default: true }), row("small"), row("old", { env_unlisted: true })],
};

function stub(state: Record<string, unknown> = status) {
	calls.length = 0;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return Response.json(state);
		})
	);
}

afterEach(() => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
});

describe("Administration -> Assistant -> Models hidden from the chat picker", () => {
	it("lists a switch per model; the default and env-unlisted ones are locked", async () => {
		stub();
		renderWithApp(HiddenModelsSection, {});
		await expect.element(page.getByTestId("hide-small")).toBeEnabled();
		await expect.element(page.getByTestId("hide-big")).toBeDisabled();
		await expect.element(page.getByTestId("hide-old")).toBeDisabled();
		await expect.element(page.getByTestId("hide-old")).toBeChecked();
	});

	it("saves the hidden ids", async () => {
		stub();
		renderWithApp(HiddenModelsSection, {});
		await page.getByTestId("hide-small").click();
		await page.getByTestId("save-hidden-models").click();
		await expect.poll(() => calls.some((c) => c.init?.method === "PUT")).toBe(true);
		const put = calls.find((c) => c.init?.method === "PUT");
		expect(put?.url).toContain("/api/v2/admin/hidden-models");
		expect(JSON.parse(String(put?.init?.body))).toEqual({ hidden: ["small"] });
	});

	it("is read-only when the deployment keeps configuration in the environment", async () => {
		stub({ ...status, configurable: false });
		renderWithApp(HiddenModelsSection, {});
		await expect.element(page.getByTestId("hide-small")).toBeDisabled();
		await expect.element(page.getByTestId("save-hidden-models")).toBeDisabled();
		await expect.element(page.getByText(/set HIDDEN_MODELS there/)).toBeVisible();
	});
});
