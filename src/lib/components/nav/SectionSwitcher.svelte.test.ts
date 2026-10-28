/**
 * The phone's section switcher, alone and on the three pages that use it
 * (Workspace, Settings, Administration): below `md` it replaces the tab row
 * with one button naming the current section, and a bottom sheet lists the
 * rest. Each section is a link to its own address.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "@vitest/browser/context";
import { createRawSnippet } from "svelte";
import { writable } from "svelte/store";
import { render } from "vitest-browser-svelte";

import SectionSwitcher from "./SectionSwitcher.svelte";
import WorkspacePanel from "$lib/components/workspace/WorkspacePanel.svelte";
import SettingsLayout from "../../../routes/settings/+layout.svelte";
import AdminLayout from "../../../routes/admin/+layout.svelte";
import LucideBoxes from "~icons/lucide/boxes";
import LucideBrain from "~icons/lucide/brain";
import { renderWithApp } from "../__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const SECTIONS = [
	{ href: "/x?tab=a", label: "Alpha", icon: LucideBoxes },
	{ href: "/x?tab=b", label: "Beta", icon: LucideBrain },
];

/** Links must not leave the test page: record the address instead. */
let followed: string[] = [];
const swallow = (event: MouseEvent) => {
	const link = (event.target as Element).closest("a");
	if (!link) return;
	event.preventDefault();
	followed.push(link.getAttribute("href") ?? "");
};
beforeEach(async () => {
	followed = [];
	document.addEventListener("click", swallow, true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ data: [], machines: [] }))
	);
	await page.viewport(390, 800);
});
afterEach(() => {
	document.removeEventListener("click", swallow, true);
	vi.unstubAllGlobals();
});

const trigger = () => page.getByTestId("section-switcher");
const sheetLabels = () =>
	[...document.querySelectorAll('[role="dialog"] a')].map((a) => a.textContent?.trim());
const nothing = createRawSnippet(() => ({ render: () => "<div></div>" }));

describe("SectionSwitcher", () => {
	it("shows the current section on a phone and lists every section in the sheet", async () => {
		render(SectionSwitcher, { label: "Things", sections: SECTIONS, current: "/x?tab=b" } as never);
		await expect.element(trigger()).toBeVisible();
		await expect.element(trigger()).toHaveTextContent("Beta");
		await expect.element(trigger()).toHaveAttribute("aria-haspopup", "dialog");
		await expect.element(trigger()).toHaveAttribute("aria-expanded", "false");

		await trigger().click();
		await expect.element(trigger()).toHaveAttribute("aria-expanded", "true");
		expect(sheetLabels()).toEqual(["Alpha", "Beta"]);
		const current = document.querySelector('[role="dialog"] a[aria-current="page"]');
		expect(current?.textContent).toContain("Beta");
		// Focus starts on the current section.
		expect(document.activeElement).toBe(current);
	});

	it("navigates by the section's own address and closes", async () => {
		render(SectionSwitcher, { label: "Things", sections: SECTIONS, current: "/x?tab=b" } as never);
		await trigger().click();
		await page.getByRole("link", { name: "Alpha" }).click();
		expect(followed).toEqual(["/x?tab=a"]);
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
	});

	it("closes on Escape and gives focus back to the button", async () => {
		render(SectionSwitcher, { label: "Things", sections: SECTIONS, current: "/x?tab=a" } as never);
		await trigger().click();
		expect(document.querySelector('[role="dialog"]')).not.toBeNull();
		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() => expect(document.querySelector('[role="dialog"]')).toBeNull());
		await expect.element(trigger()).toHaveFocus();
	});

	it("is not there from md up, where the tab row is", async () => {
		await page.viewport(1000, 800);
		render(SectionSwitcher, { label: "Things", sections: SECTIONS, current: "/x?tab=a" } as never);
		await expect.element(trigger()).not.toBeVisible();
	});
});

describe("the switcher on the pages", () => {
	it("Workspace lists its tabs, without the ones this person cannot see", async () => {
		renderWithApp(
			WorkspacePanel,
			{
				data: { models: [], knowledgeEnabled: false, memoryEnabled: false },
			} as never,
			{ page: { url: "http://localhost:3000/workspace?tab=mcp" } }
		);
		await expect.element(trigger()).toHaveTextContent("Connectors");
		await trigger().click();
		// No Knowledge, Memory or Local connectors: the same gating as the tabs.
		expect(sheetLabels()).toEqual(["Models", "Custom models", "Skills", "Connectors"]);
		await page.getByRole("link", { name: "Skills" }).click();
		expect(followed).toEqual(["/workspace?tab=skills"]);
	});

	it("Workspace offers Local connectors once the deployment has them", async () => {
		renderWithApp(WorkspacePanel, { data: { models: [], localConnectorsEnabled: true } } as never, {
			page: { url: "http://localhost:3000/workspace" },
		});
		await trigger().click();
		expect(sheetLabels()).toContain("Local connectors");
		expect(sheetLabels()).toContain("Knowledge");
	});

	it("Settings lists its sections by what the person may see", async () => {
		const context = new Map<unknown, unknown>([["settings", writable({ recentlySaved: false })]]);
		const mount = (data: Record<string, unknown>) =>
			renderWithApp(SettingsLayout, { children: nothing } as never, {
				page: { url: "http://localhost:3000/settings/application", data },
				context,
			});
		const anonymous = mount({});
		await trigger().click();
		expect(sheetLabels()).toEqual(["Application settings"]);
		anonymous.unmount();

		mount({ user: { id: "u" }, usageEnabled: true });
		await trigger().click();
		expect(sheetLabels()).toEqual(["Application settings", "Notifications", "Usage & billing"]);
		await page.getByRole("link", { name: "Notifications" }).click();
		expect(followed).toEqual(["/settings/notifications"]);
	});

	it("Administration lists its sections for an administrator and offers nothing to anyone else", async () => {
		const data = (isAdmin: boolean) => ({ signedIn: true, identity: { isAdmin } });
		const admin = renderWithApp(AdminLayout, { data: data(true), children: nothing } as never, {
			page: {
				url: "http://localhost:3000/admin/fetch",
				data: { knowledgeEnabled: false },
			},
		});
		await expect.element(trigger()).toHaveTextContent("Fetching");
		await trigger().click();
		// Knowledge hides with its pipeline, as it does in the tab row.
		expect(sheetLabels()).toEqual([
			"Web search",
			"Fetching",
			"Connectors",
			"Skills",
			"Voice",
			"Assistant instructions",
			"Sub-agents",
			"Storage",
		]);
		admin.unmount();

		renderWithApp(AdminLayout, { data: data(false), children: nothing } as never, {
			page: { url: "http://localhost:3000/admin/fetch" },
		});
		expect(document.querySelector('[data-testid="section-switcher"]')).toBeNull();
	});
});
