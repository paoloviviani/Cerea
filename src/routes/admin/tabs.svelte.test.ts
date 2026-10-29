/**
 * The administration tab row: six tabs, in this order, on one line, and the
 * console link as a small button at the end of the title row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import Layout from "./+layout.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const admin = { signedIn: true, identity: { email: "a@b.c", isAdmin: true } };

beforeEach(async () => {
	await page.viewport(1440, 900);
});
afterEach(() => {
	document.body.innerHTML = "";
});

const tabs = () =>
	[...document.querySelectorAll('nav[aria-label] a[href^="/admin/"]')].map((a) => ({
		label: a.textContent?.trim(),
		href: a.getAttribute("href"),
	}));

describe("Administration tabs", () => {
	it("are six, in order, each at its own address", async () => {
		renderWithApp(Layout, { data: admin, children: (() => {}) as never } as never, {
			page: { url: "http://localhost:3000/admin/web", data: {} },
		});
		await expect.element(page.getByRole("link", { name: "Web" })).toBeVisible();
		expect(tabs()).toEqual([
			{ label: "Knowledge", href: "/admin/knowledge" },
			{ label: "Web", href: "/admin/web" },
			{ label: "Connectors", href: "/admin/connectors" },
			{ label: "Skills", href: "/admin/skills" },
			{ label: "Assistant", href: "/admin/assistant" },
			{ label: "Storage", href: "/admin/storage" },
		]);
	});

	it("drop Knowledge, and only it, when the pipeline is off", async () => {
		renderWithApp(Layout, { data: admin, children: (() => {}) as never } as never, {
			page: { url: "http://localhost:3000/admin/web", data: { knowledgeEnabled: false } },
		});
		await expect.element(page.getByRole("link", { name: "Web" })).toBeVisible();
		expect(tabs().map((t) => t.label)).toEqual([
			"Web",
			"Connectors",
			"Skills",
			"Assistant",
			"Storage",
		]);
	});

	it("offer the console as a button named by the full sentence, only when enabled", async () => {
		renderWithApp(Layout, { data: admin, children: (() => {}) as never } as never, {
			page: { url: "http://localhost:3000/admin/web", data: { consoleEnabled: true } },
		});
		const link = page.getByRole("link", {
			name: "Manage providers, models, limits and users in the console",
		});
		await expect.element(link).toHaveTextContent("Console");
		await expect.element(link).toHaveAttribute("href", "/console");
		document.body.innerHTML = "";

		renderWithApp(Layout, { data: admin, children: (() => {}) as never } as never, {
			page: { url: "http://localhost:3000/admin/web", data: {} },
		});
		await expect.element(page.getByRole("link", { name: "Web" })).toBeVisible();
		expect(document.querySelector('a[href="/console"]')).toBeNull();
	});
});
