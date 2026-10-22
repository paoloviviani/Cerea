import { describe, it, expect, vi, beforeEach } from "vitest";
import { page as browserPage } from "@vitest/browser/context";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import MachineProfilesDialog from "./MachineProfilesDialog.svelte";
import type { CodeDeviceView } from "$lib/codeApi";

/**
 * The delegate-profiles dialog: a list of name + model rows, one default,
 * add and remove, Save replaces the machine's whole set. What is under test is
 * what the dialog owns: it reads the set and the machine's model list, sends
 * exactly the edited set, shows what the machine stored (and what it refused),
 * and stays disabled, with the reason, for a machine that cannot take it.
 */
const api = vi.hoisted(() => ({
	getDelegateProfiles: vi.fn(),
	setDelegateProfiles: vi.fn(),
	listProviderModels: vi.fn(),
}));

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

vi.mock("$lib/codeApi", async (importOriginal) => {
	const original = await importOriginal<typeof import("$lib/codeApi")>();
	return {
		...original,
		getDelegateProfiles: api.getDelegateProfiles,
		setDelegateProfiles: api.setDelegateProfiles,
		listProviderModels: api.listProviderModels,
	};
});

function device(over: Partial<CodeDeviceView> = {}): CodeDeviceView {
	return {
		id: "d1",
		name: "Box d1",
		status: "paired",
		online: true,
		backends: [{ id: "opencode", version: "1", capabilities: {} }],
		machine: { capabilities: { delegateProfiles: true } },
		policy: { workspaceRoots: [], allowFreeModels: false },
		...over,
	} as CodeDeviceView;
}

function mount(d: CodeDeviceView = device()) {
	return renderWithApp(MachineProfilesDialog, { device: d, onclose: () => {} }, undefined);
}

const ROWS = () =>
	Array.from(document.body.querySelectorAll<HTMLElement>('[data-testid="profile-rows"] > li'));

beforeEach(() => {
	api.getDelegateProfiles.mockReset().mockResolvedValue({
		default: "deep",
		profiles: [
			{ name: "deep", model: "gw/deep" },
			{ name: "fast", model: "gw/fast" },
		],
	});
	api.setDelegateProfiles.mockReset().mockImplementation(async (_id, set) => set);
	api.listProviderModels.mockReset().mockResolvedValue({
		models: [
			{ id: "gw/fast", label: "Fast" },
			{ id: "gw/deep", label: "Deep" },
		],
	});
});

describe("MachineProfilesDialog", () => {
	it("lists the machine's profiles with their model and the default marked", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await vi.waitFor(() => expect(ROWS()).toHaveLength(2));
		expect(api.getDelegateProfiles).toHaveBeenCalledWith("d1");
		expect(api.listProviderModels).toHaveBeenCalledWith("d1", "opencode");
		const names = ROWS().map(
			(r) => r.querySelector<HTMLInputElement>('input[type="text"], input:not([type])')?.value
		);
		expect(names).toEqual(["deep", "fast"]);
		const selects = ROWS().map((r) => r.querySelector("select")?.value);
		expect(selects).toEqual(["gw/deep", "gw/fast"]);
		const radios = ROWS().map(
			(r) => r.querySelector<HTMLInputElement>('input[type="radio"]')?.checked
		);
		expect(radios).toEqual([true, false]);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("sends the edited set: a new profile, another default, a removal", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await vi.waitFor(() => expect(ROWS()).toHaveLength(2));
		await screen.getByRole("button", { name: "Add profile" }).click();
		await vi.waitFor(() => expect(ROWS()).toHaveLength(3));
		await screen.getByLabelText("Profile 3 name").fill("review");
		await screen.getByLabelText("Profile 3 model").selectOptions("gw/deep");
		await screen.getByLabelText("Make profile review the default").click();
		await screen.getByLabelText("Remove profile fast").click();
		await screen.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() => expect(api.setDelegateProfiles).toHaveBeenCalledTimes(1));
		expect(api.setDelegateProfiles.mock.calls[0]).toEqual([
			"d1",
			{
				default: "review",
				profiles: [
					{ name: "deep", model: "gw/deep" },
					{ name: "review", model: "gw/deep" },
				],
			},
		]);
		await expect.element(screen.getByText("Saved.")).toBeVisible();
	});

	it("removing the default profile leaves no default", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await vi.waitFor(() => expect(ROWS()).toHaveLength(2));
		await screen.getByLabelText("Remove profile deep").click();
		await screen.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() => expect(api.setDelegateProfiles).toHaveBeenCalledTimes(1));
		expect(api.setDelegateProfiles.mock.calls[0][1]).toEqual({
			default: null,
			profiles: [{ name: "fast", model: "gw/fast" }],
		});
	});

	it("does not offer Save for a bad or repeated name, and says why", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount();
		await vi.waitFor(() => expect(ROWS()).toHaveLength(2));
		// A dot is not something the field folds away (unlike a space or a capital).
		await screen.getByLabelText("Profile 2 name").fill("bad.name");
		await expect
			.element(screen.getByTestId("profiles-invalid"))
			.toHaveTextContent("not a valid name");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await screen.getByLabelText("Profile 2 name").fill("deep");
		await expect.element(screen.getByTestId("profiles-invalid")).toHaveTextContent("used twice");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(api.setDelegateProfiles).not.toHaveBeenCalled();
	});

	it("shows the machine's refusal and keeps the edit", async () => {
		await browserPage.viewport(1200, 800);
		api.setDelegateProfiles.mockRejectedValue(
			new Error('profile "fast": model "x" is not offered')
		);
		const screen = mount();
		await vi.waitFor(() => expect(ROWS()).toHaveLength(2));
		await screen.getByRole("button", { name: "Save" }).click();
		await expect.element(screen.getByText("is not offered")).toBeVisible();
		expect(ROWS()).toHaveLength(2);
	});

	it("is an empty state with no profiles, and Save then clears the machine's set", async () => {
		await browserPage.viewport(1200, 800);
		api.getDelegateProfiles.mockResolvedValue({ default: null, profiles: [] });
		const screen = mount();
		await expect.element(screen.getByText("No profiles.")).toBeVisible();
		await screen.getByRole("button", { name: "Save" }).click();
		await vi.waitFor(() => expect(api.setDelegateProfiles).toHaveBeenCalledTimes(1));
		expect(api.setDelegateProfiles.mock.calls[0][1]).toEqual({ default: null, profiles: [] });
	});

	it("is disabled with the update message for a galopin without the capability", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount(device({ machine: { capabilities: {} } }));
		await expect
			.element(screen.getByTestId("profiles-unavailable"))
			.toHaveTextContent("update galopin on this machine");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Add profile" })).toBeDisabled();
		expect(api.getDelegateProfiles).not.toHaveBeenCalled();
	});

	it("is disabled with a clear message for an offline machine", async () => {
		await browserPage.viewport(1200, 800);
		const screen = mount(device({ online: false }));
		await expect.element(screen.getByTestId("profiles-unavailable")).toHaveTextContent("offline");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		expect(api.getDelegateProfiles).not.toHaveBeenCalled();
	});
});
