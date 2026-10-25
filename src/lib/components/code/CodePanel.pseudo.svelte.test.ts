import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { unbracketedText } from "$lib/components/__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import { resetCodeReauth, codeReauth } from "$lib/stores/codeReauth.svelte";
import CodePanel from "./CodePanel.svelte";
import CodeReauthCard from "./CodeReauthCard.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: async () => ({ devices: [] }),
	listPendingApprovals: async () => ({ permissions: [], questions: [] }),
	loadCodeStatus: async () => {},
}));

beforeEach(() => {
	resetCodeReauth();
	codeDeviceList.devices = [];
	codeDeviceList.loading = false;
	overwriteGetLocale(() => "en-XA");
});
afterEach(() => overwriteGetLocale(() => "en"));

describe("The Code panel, in the pseudo-locale", () => {
	it("owns the words of the disabled state", async () => {
		const screen = renderWithApp(CodePanel, { enabled: false });
		await expect
			.element(screen.getByText(m["code.panel.disabled_title"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedText()).toEqual([]);
	});

	it("owns the words of the sign-in card", async () => {
		codeReauth.signedOut = true;
		const screen = renderWithApp(CodeReauthCard);
		await expect
			.element(screen.getByText(m["code.reauth.signed_out"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(unbracketedText()).toEqual([]);
	});
});
