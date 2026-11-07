import { describe, it, expect, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import AgentsFirstRun from "./AgentsFirstRun.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: async () => ({ devices: [] }),
}));

describe("the Agents first screen with no computer", () => {
	it("explains what an agent is and offers one step", async () => {
		const screen = renderWithApp(AgentsFirstRun, {});
		await expect.element(screen.getByText("Agents work on your computer")).toBeVisible();
		await expect.element(screen.getByText(/asks you before anything that matters/)).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Connect a computer" })).toBeVisible();
	});

	it("opens the pair dialog from the button", async () => {
		const screen = renderWithApp(
			AgentsFirstRun,
			{},
			{
				page: {
					data: {
						codeOidcIssuerUrl: "https://i.example/r",
						codeGatewayOrigin: "https://g.example",
					},
				},
				publicConfig: { PUBLIC_ORIGIN: "https://chat.example" },
			}
		);
		await screen.getByRole("button", { name: "Connect a computer" }).click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
	});
});
