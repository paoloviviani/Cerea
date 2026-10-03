import { describe, it, expect, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PairDeviceDialog from "./PairDeviceDialog.svelte";

/**
 * The enrollment dialog prints the command a person runs on their machine.
 * Allow auto-accept is a checkbox again: ticking it adds --allow-auto-accept
 * (the machine ceiling's "responders allowed" setting) to the printed
 * command. The dialog copy promises only what the flag means — per-session
 * answering stays on the panel switch.
 */
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: async () => ({ devices: [] }),
}));

function mount() {
	return renderWithApp(
		PairDeviceDialog,
		{ onclose: () => {}, onpaired: () => {} },
		{
			page: {
				data: {
					codeOidcIssuerUrl: "https://issuer.example/realms/r",
					codeGatewayOrigin: "https://gw.example",
				},
			},
			publicConfig: { PUBLIC_ORIGIN: "https://chat.example" },
		}
	);
}

function command(screen: ReturnType<typeof mount>): string {
	return screen.getByTestId("galopin-enroll-command").element().textContent?.trim() ?? "";
}

describe("PairDeviceDialog", () => {
	it("offers all four checkboxes, off by default", async () => {
		const screen = mount();
		await expect.element(screen.getByText("Pair a machine")).toBeVisible();
		await expect.element(screen.getByRole("checkbox", { name: /Allow auto-accept/ })).toBeVisible();
		await expect.element(screen.getByRole("checkbox", { name: /Install opencode/ })).toBeVisible();
		await expect
			.element(screen.getByRole("checkbox", { name: /Trust the repos this machine opens/ }))
			.toBeVisible();
		await expect.element(screen.getByRole("checkbox", { name: /Allow terminal/ })).toBeVisible();
		expect(command(screen)).not.toContain("--allow-auto-accept");
	});

	it("adds --allow-auto-accept to the command only when ticked", async () => {
		const screen = mount();
		expect(command(screen)).toContain("enroll");
		expect(command(screen)).not.toContain("--allow-auto-accept");
		await screen.getByRole("checkbox", { name: /Allow auto-accept/ }).click();
		expect(command(screen)).toContain("--allow-auto-accept");
		await screen.getByRole("checkbox", { name: /Allow terminal/ }).click();
		expect(command(screen)).toContain("--allow-terminal");
		expect(command(screen)).toContain("--allow-auto-accept");
	});

	it("says what the flag means without promising per-session behaviour", async () => {
		const screen = mount();
		const note = screen.getByTestId("pair-permissions-note");
		await expect.element(note).toBeVisible();
		const text = note.element().textContent?.replace(/\s+/g, " ") ?? "";
		expect(text).toContain("opencode's own permission rules");
		expect(text).toContain("--allow-auto-accept");
		expect(text).toContain('"allow once"');
		expect(text).toContain("never questions or denies");
		expect(text).not.toMatch(/without a person|unattended|every ask|all asks/i);
	});
});
