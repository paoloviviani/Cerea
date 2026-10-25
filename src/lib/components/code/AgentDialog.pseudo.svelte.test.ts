import { afterEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { unbracketedText } from "$lib/components/__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import AgentDialog from "./AgentDialog.svelte";
import PermissionsDialog from "./PermissionsDialog.svelte";
import MachineProfilesDialog from "./MachineProfilesDialog.svelte";

const api = vi.hoisted(() => ({
	listProviders: vi.fn(),
	getPermissionRules: vi.fn(),
	getDelegateProfiles: vi.fn(),
	listProviderModels: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

afterEach(() => overwriteGetLocale(() => "en"));

describe("The Code dialogs, in the pseudo-locale", () => {
	it("the new-agent dialog owns every word it shows", async () => {
		overwriteGetLocale(() => "en-XA");
		api.listProviders.mockResolvedValue({ providers: [{ id: "opencode", available: true }] });
		const screen = renderWithApp(AgentDialog, {
			deviceId: "d1",
			workspace: { id: "w1", path: "/home/me/project", name: "project" } as never,
			onclose: () => {},
			oncreated: () => {},
		});
		await expect
			.element(screen.getByText(m["code.agent_dialog.title"]({}, { locale: "en-XA" })))
			.toBeVisible();
		await expect
			.element(screen.getByText(m["code.agent_dialog.posture"]({}, { locale: "en-XA" })))
			.toBeVisible();
		// The workspace's own name and path, and the backend's name, are data.
		expect(unbracketedText(document.body, [/project/, /opencode/])).toEqual([]);
	});

	it("the permissions dialog owns every word it shows", async () => {
		overwriteGetLocale(() => "en-XA");
		api.getPermissionRules.mockResolvedValue({
			mode: "ask",
			rules: [
				{ permission: "edit", pattern: "*", action: "ask", source: "cerea" },
				{ permission: "bash", pattern: "*", action: "deny", source: "ceiling" },
			],
			savedApprovals: [{ id: "ex_1", permission: "edit", patterns: ["src/**"], removable: true }],
			ceiling: {},
			coordination: [],
		});
		const screen = renderWithApp(PermissionsDialog, {
			deviceId: "d1",
			agentId: "a1",
			sessionTitle: "Build it",
			onclose: () => {},
		});
		await expect.element(screen.getByTestId("permissions-detail")).toBeVisible();
		await expect
			.element(screen.getByText(m["code.permissions.exceptions"]({}, { locale: "en-XA" })))
			.toBeVisible();
		expect(
			unbracketedText(document.body, [/Build it/, /^edit$/, /^bash$/, /src\//, /^\((edit|bash)\)$/])
		).toEqual([]);
	});

	it("the delegate profiles dialog owns every word it shows", async () => {
		overwriteGetLocale(() => "en-XA");
		api.getDelegateProfiles.mockResolvedValue({
			default: "fast",
			profiles: [{ name: "fast", model: "gw/small" }],
		});
		api.listProviderModels.mockResolvedValue({
			models: [{ id: "gw/small", label: "Small model" }],
		});
		const screen = renderWithApp(MachineProfilesDialog, {
			device: {
				id: "d1",
				name: "Build box",
				status: "paired",
				online: true,
				backends: [{ id: "opencode" }],
				machine: { capabilities: { delegateProfiles: true } },
			} as never,
			onclose: () => {},
		});
		await expect
			.element(screen.getByText(m["code.profiles.title"]({}, { locale: "en-XA" })))
			.toBeVisible();
		await expect.element(screen.getByTestId("profile-rows")).toBeVisible();
		expect(unbracketedText(document.body, [/Build box/, /Small model/, /^fast$/])).toEqual([]);
	});
});
