import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { unbracketedText } from "$lib/components/__tests__/pseudoText";
import { m } from "$lib/paraglide/messages";
import { overwriteGetLocale } from "$lib/paraglide/runtime.js";
import { codeDeviceList } from "$lib/stores/codeDeviceList.svelte";
import CodeNavTree from "./CodeNavTree.svelte";

const api = vi.hoisted(() => ({
	listDevices: vi.fn(),
	listWorkspaces: vi.fn(),
	listAgents: vi.fn(),
}));

vi.mock("$lib/codeApi", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/codeApi")>()),
	...api,
}));

beforeEach(() => {
	codeDeviceList.devices = [];
	codeDeviceList.loading = true;
	overwriteGetLocale(() => "en-XA");
});
afterEach(() => overwriteGetLocale(() => "en"));

describe("The Agents tree, in the pseudo-locale", () => {
	it("owns every word it shows", async () => {
		api.listDevices.mockResolvedValue({
			devices: [
				{ id: "d1", name: "Build box", status: "paired", online: true },
				{ id: "d2", name: "New box", status: "pending", online: true },
			],
		});
		api.listWorkspaces.mockResolvedValue({
			workspaces: [{ id: "w1", name: "alpha", path: "/a", isGitRepo: false }],
		});
		api.listAgents.mockResolvedValue({
			agents: [
				{
					id: "a1",
					workspaceId: "w1",
					title: "Agent one",
					provider: "opencode",
					state: "waiting-permission",
					updatedAt: "2026-09-30T00:00:00Z",
					modeId: null,
					modelId: null,
				},
			],
		});
		const screen = renderWithApp(CodeNavTree);
		await expect
			.element(screen.getByText(m["code.nav.devices"]({}, { locale: "en-XA" })))
			.toBeVisible();
		await expect.element(screen.getByText("Agent one")).toBeVisible();
		await expect
			.element(screen.getByText(m["code.nav.waiting"]({}, { locale: "en-XA" })))
			.toBeVisible();
		// Machine, workspace and session names are data.
		expect(
			unbracketedText(document.body, [/Build box/, /New box/, /^alpha$/, /Agent one/])
		).toEqual([]);
	});
});
