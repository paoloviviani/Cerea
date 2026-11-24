import { describe, it, expect, afterEach } from "vitest";
import { page } from "@vitest/browser/context";
import { renderWithApp, unmountRendered } from "$lib/components/__tests__/renderWithApp";
import DeviceRunMode from "./DeviceRunMode.svelte";
import { knownRunMode } from "$lib/galopinRunMode";
import type { CodeDeviceView } from "$lib/server/codeDevices";

afterEach(() => unmountRendered());

function device(over: Partial<CodeDeviceView> = {}): CodeDeviceView {
	return {
		id: "d1",
		name: "box",
		status: "paired",
		backends: [],
		policy: {},
		credentialState: "ok",
		online: true,
		createdAt: new Date(),
		...over,
	} as CodeDeviceView;
}

describe("DeviceRunMode", () => {
	it.each([
		["service", "Runs as a service", "galopin service uninstall"],
		["system_service", "Runs as a system service", "sudo systemctl stop galopin"],
		["terminal", "Runs in a terminal", "galopin service install"],
		["mac_app", "Runs under the Mac app", "Quit the app"],
		["docker", "Runs in a container", "docker stop"],
	])("shows %s with how to stop it in an accessible disclosure", async (mode, label, hint) => {
		renderWithApp(DeviceRunMode, { device: device({ agentRunMode: mode }) });
		const el = page.getByTestId("device-run-mode");
		await expect.element(el).toHaveTextContent(label);
		// the guidance is page content (a <details> body), not a hover-only title
		const help = page.getByTestId("device-run-mode-help");
		expect(help.element().textContent).toContain(hint);
		expect(el.element().tagName).toBe("DETAILS");
		expect(el.element().querySelector("summary")?.textContent).toContain(label);
		expect(el.element().getAttribute("title")).toBeNull();
		expect(el.element().getAttribute("data-mode")).toBe(mode);
	});

	it("shows nothing for an older galopin or a word it does not know", async () => {
		renderWithApp(DeviceRunMode, { device: device() });
		expect(document.querySelector("[data-testid=device-run-mode]")).toBeNull();
		unmountRendered();
		renderWithApp(DeviceRunMode, { device: device({ agentRunMode: "kubernetes" }) });
		expect(document.querySelector("[data-testid=device-run-mode]")).toBeNull();
	});

	it("knows exactly the five words galopin reports", () => {
		expect(
			["service", "terminal", "mac_app", "docker", "x", null, undefined].map(knownRunMode)
		).toEqual(["service", "terminal", "mac_app", "docker", null, null, null]);
	});
});
