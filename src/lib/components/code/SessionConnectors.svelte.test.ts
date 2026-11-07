import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { get } from "svelte/store";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import SessionConnectors from "./SessionConnectors.svelte";
import ConnectorSwitches from "./ConnectorSwitches.svelte";
import { error as errorToast } from "$lib/stores/errors";

/**
 * A coding session's connector switches (ADR 0108, item 3): a list of switches by name, none on by
 * default; each change saves the whole selection to Cerea and shows what Cerea answers. A
 * connector that cannot be used now (switched off in Workspace, needing a sign-in) is shown off,
 * disabled and says why.
 */
const api = vi.hoisted(() => ({
	getSessionConnectors: vi.fn(),
	setSessionConnectors: vi.fn(),
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));
vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	getSessionConnectors: api.getSessionConnectors,
	setSessionConnectors: api.setSessionConnectors,
}));

const OPTIONS = [
	{ key: "connector:a", name: "Tracker", kind: "connector", summary: "Issues and boards" },
	{ key: "base:maps", name: "Maps", kind: "base", summary: "", locked: true },
	{ key: "local:d1:notes", name: "notes", kind: "local", summary: "My notes" },
	{
		key: "connector:n",
		name: "Notion",
		kind: "connector",
		summary: "",
		unavailable: "needs sign-in",
	},
	{ key: "connector:o", name: "Old", kind: "connector", summary: "", unavailable: "switched off" },
];

beforeEach(async () => {
	errorToast.set(undefined);
	api.getSessionConnectors.mockReset().mockResolvedValue({ options: OPTIONS, selected: [] });
	api.setSessionConnectors
		.mockReset()
		.mockImplementation(async (_d: string, _s: string, keys: string[]) => ({ selected: keys }));
	await browserPage.viewport(1200, 800);
});

const checkbox = (screen: ReturnType<typeof renderWithApp>, name: string) =>
	screen.getByTestId(`connector-switch-${name}`);

describe("the session's connector switches", () => {
	it("lists every connector by name with nothing on by default", async () => {
		const screen = renderWithApp(SessionConnectors, { deviceId: "d1", sessionId: "s1" });
		await expect.element(checkbox(screen, "Tracker")).toBeInTheDocument();
		for (const name of ["Tracker", "Maps", "notes"]) {
			await expect.element(checkbox(screen, name)).not.toBeChecked();
			await expect.element(checkbox(screen, name)).toBeEnabled();
		}
		expect(api.getSessionConnectors).toHaveBeenCalledWith("d1", "s1");
		await expect.element(screen.getByText("on this computer")).toBeInTheDocument();
	});

	it("saves the whole selection on each switch, and shows what Cerea answered", async () => {
		const screen = renderWithApp(SessionConnectors, { deviceId: "d1", sessionId: "s1" });
		await checkbox(screen, "Tracker").click();
		await expect.element(checkbox(screen, "Tracker")).toBeChecked();
		expect(api.setSessionConnectors).toHaveBeenLastCalledWith("d1", "s1", ["connector:a"]);
		await checkbox(screen, "notes").click();
		expect(api.setSessionConnectors).toHaveBeenLastCalledWith("d1", "s1", [
			"connector:a",
			"local:d1:notes",
		]);
		await checkbox(screen, "Tracker").click();
		expect(api.setSessionConnectors).toHaveBeenLastCalledWith("d1", "s1", ["local:d1:notes"]);
		await expect.element(checkbox(screen, "Tracker")).not.toBeChecked();
	});

	it("shows a connector that needs a sign-in, or was switched off, as off and disabled, saying why", async () => {
		api.getSessionConnectors.mockResolvedValue({
			options: OPTIONS,
			// A stale opt-in for one that stopped being usable is not shown as on.
			selected: ["connector:n", "connector:a"],
		});
		const screen = renderWithApp(SessionConnectors, { deviceId: "d1", sessionId: "s1" });
		await expect.element(checkbox(screen, "Notion")).toBeDisabled();
		await expect.element(checkbox(screen, "Notion")).not.toBeChecked();
		await expect.element(checkbox(screen, "Old")).toBeDisabled();
		await expect.element(screen.getByText("needs sign-in")).toBeInTheDocument();
		await expect.element(screen.getByText("switched off in Workspace")).toBeInTheDocument();
		await expect.element(checkbox(screen, "Tracker")).toBeChecked();
	});

	it("keeps the old selection and says so when the save fails", async () => {
		api.setSessionConnectors.mockRejectedValue(new Error("That computer is not one of yours."));
		const screen = renderWithApp(SessionConnectors, { deviceId: "d1", sessionId: "s1" });
		await checkbox(screen, "Maps").click();
		await vi.waitFor(() => expect(get(errorToast)).toBe("That computer is not one of yours."));
		await expect.element(checkbox(screen, "Maps")).not.toBeChecked();
	});

	it("says it could not read the connectors, rather than showing an empty list as final", async () => {
		api.getSessionConnectors.mockRejectedValue(new Error("down"));
		const screen = renderWithApp(SessionConnectors, { deviceId: "d1", sessionId: "s1" });
		await expect.element(screen.getByTestId("connectors-unavailable")).toBeInTheDocument();
	});
});

describe("the switch list on its own", () => {
	it("says there is nothing to switch on when the user has no connectors", async () => {
		const screen = renderWithApp(ConnectorSwitches, {
			options: [],
			selected: [],
			onchange: () => {},
		});
		await expect.element(screen.getByTestId("connectors-none")).toBeInTheDocument();
	});
});
