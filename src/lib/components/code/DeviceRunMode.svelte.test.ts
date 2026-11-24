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
		["terminal", "Runs in a terminal", "galopin service install"],
		["mac_app", "Runs under the Mac app", "Quit the app"],
		["docker", "Runs in a container", "docker stop"],
	])("shows %s with how to stop it in the tooltip", async (mode, label, hint) => {
		renderWithApp(DeviceRunMode, { device: device({ agentRunMode: mode }) });
		const el = page.getByTestId("device-run-mode");
		await expect.element(el).toHaveTextContent(label);
		expect(el.element().getAttribute("title")).toContain(hint);
		expect(el.element().getAttribute("data-mode")).toBe(mode);
	});

	it("shows nothing for an older galopin or a word it does not know", async () => {
		renderWithApp(DeviceRunMode, { device: device() });
		expect(document.querySelector("[data-testid=device-run-mode]")).toBeNull();
		unmountRendered();
		renderWithApp(DeviceRunMode, { device: device({ agentRunMode: "kubernetes" }) });
		expect(document.querySelector("[data-testid=device-run-mode]")).toBeNull();
	});

	it("knows exactly the four words galopin reports", () => {
		expect(
			["service", "terminal", "mac_app", "docker", "x", null, undefined].map(knownRunMode)
		).toEqual(["service", "terminal", "mac_app", "docker", null, null, null]);
	});
});
