import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { unbracketedText } from "$lib/components/__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import PairDeviceDialog from "./PairDeviceDialog.svelte";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	listDevices: async () => ({ devices: [] }),
}));

afterEach(() => overwriteGetLocale(() => "en"));

describe("Pair a machine, in the pseudo-locale", () => {
	it("owns every word it shows", async () => {
		overwriteGetLocale(() => "en-XA");
		const screen = renderWithApp(
			PairDeviceDialog,
			{ onclose: () => {}, onpaired: () => {} },
			{
				page: { data: { codeOidcIssuerUrl: "https://issuer.example", codeGatewayOrigin: "" } },
				publicConfig: { PUBLIC_ORIGIN: "https://chat.example" },
			}
		);
		const title = m["code.pair.title"]({}, { locale: "en-XA" });
		expect(title).toMatch(/^\[.+\]$/);
		await expect.element(screen.getByText(title)).toBeVisible();
		await expect
			.element(screen.getByText(m["code.enroll.title"]({}, { locale: "en-XA" })))
			.toBeVisible();

		// Only the printed command, file names and platform strings are not words.
		expect(
			unbracketedText(document.body, [
				/^galopin\b/,
				/^\(galopin-/,
				/^SHA256SUMS/,
				/^--/,
				// The printed commands, and the shared copy button.
				/^(curl|~\/)/,
				/^Cop(ied|y to clipboard)$/,
			])
		).toEqual([]);
	});
});
