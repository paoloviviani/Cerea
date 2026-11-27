import { describe, it, expect, vi, afterEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp, unmountRendered } from "$lib/components/__tests__/renderWithApp";
import DeviceUpgrade from "./DeviceUpgrade.svelte";
import { APP_VERSION } from "$lib/utils/appVersion";
import { GALOPIN_IMAGE } from "$lib/codeEnrollCommand";
import type { CodeDeviceView } from "$lib/server/codeDevices";

/**
 * The Upgrade button (C159): offered only to the owner of an online computer that reported
 * `agent.upgrade.inPlace: true` and runs an older galopin. Every other case shows the
 * instructions that fit it, never the button.
 */
vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const api = vi.hoisted(() => ({ started: [] as string[] }));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	startUpgrade: async (id: string) => {
		api.started.push(id);
		return { started: true };
	},
	listDevices: async () => ({ devices: [] }),
}));

const ORIGIN = "https://chat.example";

afterEach(() => {
	api.started = [];
	unmountRendered();
});

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
		agentVersion: "0.1.0",
		...over,
	} as CodeDeviceView;
}

function mount(d: CodeDeviceView) {
	return renderWithApp(
		DeviceUpgrade,
		{ device: d, origin: ORIGIN },
		{ publicConfig: { PUBLIC_ORIGIN: ORIGIN } }
	);
}

const CURL = `curl -fsSL '${ORIGIN}/galopin/install.sh' | sh -s -- --upgrade`;

describe("DeviceUpgrade", () => {
	it("offers the button, with a confirm that names both versions, only in the allowed case", async () => {
		await browserPage.viewport(1000, 900);
		const screen = mount(device({ agentUpgrade: { inPlace: true, reason: "systemd" } }));
		await expect.element(screen.getByTestId("device-upgrade-button")).toBeVisible();
		expect(screen.getByText(CURL).elements()).toHaveLength(0);
		await screen.getByTestId("device-upgrade-button").click();
		const text = screen.getByTestId("device-upgrade-confirm").element().textContent ?? "";
		expect(text).toContain("0.1.0");
		expect(text).toContain(APP_VERSION);
		expect(text).toContain("goes offline for about a minute");
		await screen.getByTestId("device-upgrade-confirm-button").click();
		await vi.waitFor(() => expect(api.started).toEqual(["d1"]));
	});

	it.each([
		["offline", device({ online: false, agentUpgrade: { inPlace: true, reason: "systemd" } })],
		["mac app", device({ agentUpgrade: { inPlace: false, reason: "mac_app" } })],
		["desktop app", device({ agentUpgrade: { inPlace: false, reason: "desktop_app" } })],
		["docker", device({ agentUpgrade: { inPlace: false, reason: "docker" } })],
		["a container with no capability", device({ agentContainer: true })],
		["launchd", device({ agentUpgrade: { inPlace: false, reason: "launchd" } })],
		["foreground", device({ agentUpgrade: { inPlace: false, reason: "foreground" } })],
		["disabled", device({ agentUpgrade: { inPlace: false, reason: "disabled" } })],
		["an old galopin", device()],
	])("never offers the button: %s", async (_name, d) => {
		await browserPage.viewport(1000, 900);
		const screen = mount(d);
		await expect.element(screen.getByTestId("device-upgrade")).toBeVisible();
		expect(screen.getByTestId("device-upgrade-button").elements()).toHaveLength(0);
	});

	it("shows the instructions that fit each case", async () => {
		await browserPage.viewport(1000, 900);
		const how = async (d: CodeDeviceView) => {
			const screen = mount(d);
			await expect.element(screen.getByTestId("device-upgrade")).toBeVisible();
			const el = screen.getByTestId("device-upgrade").element();
			const out = { how: el.getAttribute("data-how"), text: el.textContent ?? "" };
			unmountRendered();
			return out;
		};
		const mac = await how(device({ agentUpgrade: { inPlace: false, reason: "mac_app" } }));
		expect(mac.how).toBe("mac_app");
		expect(mac.text).toContain("connector app");
		expect(mac.text).not.toContain("curl");
		const desk = await how(device({ agentUpgrade: { inPlace: false, reason: "desktop_app" } }));
		expect(desk.how).toBe("desktop_app");
		expect(desk.text).toContain("galopin updates with the Cerea desktop app");
		expect(desk.text).not.toContain("curl");
		expect(desk.text).not.toContain("install.sh");
		const docker = await how(device({ agentUpgrade: { inPlace: false, reason: "docker" } }));
		expect(docker.how).toBe("docker");
		expect(docker.text).toContain(`docker pull ${GALOPIN_IMAGE}:${APP_VERSION}`);
		const launchd = await how(device({ agentUpgrade: { inPlace: false, reason: "launchd" } }));
		expect(launchd.how).toBe("launchd");
		expect(launchd.text).toContain("galopin service uninstall");
		expect(launchd.text).toContain(CURL);
		const fg = await how(device({ agentUpgrade: { inPlace: false, reason: "foreground" } }));
		expect(fg.how).toBe("foreground");
		expect(fg.text).toContain("outside galopin");
		expect(fg.text).toContain(CURL);
		const off = await how(device({ agentUpgrade: { inPlace: false, reason: "disabled" } }));
		expect(off.text).toContain(CURL);
		const old = await how(device());
		expect(old.text).toContain(CURL);
	});

	it("links the desktop app's galopin to the release page, with no command", async () => {
		await browserPage.viewport(1000, 900);
		const screen = mount(device({ agentUpgrade: { inPlace: false, reason: "desktop_app" } }));
		const link = screen.getByTestId("device-upgrade-desktop-releases");
		await expect.element(link).toBeVisible();
		await expect.element(link).toHaveTextContent("release page");
		await expect
			.element(link)
			.toHaveAttribute("href", "https://github.com/paoloviviani/Cerea/releases");
		expect(screen.getByTestId("device-upgrade").element().querySelector("pre")).toBeNull();
	});

	it("shows an upgrade in progress, done and not completed", async () => {
		await browserPage.viewport(1000, 900);
		const run = {
			startedAt: new Date(),
			fromVersion: "0.1.0",
			targetVersion: APP_VERSION,
		};
		const running = mount(
			device({
				agentUpgrade: { inPlace: true, reason: "systemd" },
				upgrade: { ...run, state: "running" },
			})
		);
		await expect.element(running.getByTestId("device-upgrade-state")).toBeVisible();
		expect(running.getByTestId("device-upgrade-state").element().textContent).toContain(
			"Upgrading box"
		);
		// no second start while one runs
		expect(running.getByTestId("device-upgrade-button").elements()).toHaveLength(0);
		unmountRendered();

		const done = mount(
			device({
				agentVersion: APP_VERSION,
				upgrade: { ...run, state: "done", version: APP_VERSION },
			})
		);
		await expect.element(done.getByTestId("device-upgrade-state")).toBeVisible();
		expect(done.getByTestId("device-upgrade-state").element().textContent).toContain(
			`Updated to ${APP_VERSION}`
		);
		unmountRendered();

		const failed = mount(
			device({
				upgrade: { ...run, state: "failed" },
				agentUpgrade: { inPlace: false, reason: "foreground" },
			})
		);
		await expect.element(failed.getByTestId("device-upgrade-state")).toBeVisible();
		const failedText = failed.getByTestId("device-upgrade-state").element().textContent ?? "";
		expect(failedText).toContain("did not complete");
		expect(failedText).toContain("backups/upgrade-");
	});
});
