import { describe, it, expect, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import PairDeviceDialog from "./PairDeviceDialog.svelte";

/**
 * The enrollment dialog prints the command a person runs on their machine.
 * Auto-accept is no longer a checkbox here: the flag survives on the CLI as
 * the machine ceiling's "responders allowed" setting, and the dialog says so
 * in plain words instead of offering per-session behaviour it cannot promise.
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
	it("offers no Allow auto-accept checkbox", async () => {
		const screen = mount();
		await expect.element(screen.getByText("Pair a machine")).toBeVisible();
		expect(screen.getByRole("checkbox", { name: /auto-accept/i }).elements()).toHaveLength(0);
		expect(screen.getByText("Allow auto-accept.").elements()).toHaveLength(0);
		// The three that remain are still there.
		await expect.element(screen.getByRole("checkbox", { name: /Install opencode/ })).toBeVisible();
		await expect
			.element(screen.getByRole("checkbox", { name: /Trust repo configs/ }))
			.toBeVisible();
		await expect.element(screen.getByRole("checkbox", { name: /Allow terminal/ })).toBeVisible();
	});

	it("prints an enroll command with no --allow-auto-accept, whatever the other boxes say", async () => {
		const screen = mount();
		expect(command(screen)).toContain("enroll");
		expect(command(screen)).not.toContain("--allow-auto-accept");
		await screen.getByRole("checkbox", { name: /Allow terminal/ }).click();
		await screen.getByRole("checkbox", { name: /Trust repo configs/ }).click();
		expect(command(screen)).toContain("--allow-terminal");
		expect(command(screen)).toContain("--allow-project-config");
		expect(command(screen)).not.toContain("--allow-auto-accept");
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
