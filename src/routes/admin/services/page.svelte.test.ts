/**
 * The Services page: the rows with their health and line, Refresh, and the
 * update check (the only thing that reaches outside, and only on a click).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "@vitest/browser/context";

import Services from "./+page.svelte";
import { renderWithApp, unmountRendered } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const report = {
	checkedAt: "2026-11-13T10:00:00.000Z",
	cached: false,
	rows: [
		{ id: "gateway", health: "ok", note: "gateway_ok" },
		{ id: "embedding", health: "degraded", note: "embedding_missing", param: "emb-1" },
		{ id: "blobs", health: "down", note: "blobs_down" },
		{ id: "sandbox", health: "off", note: "not_configured" },
		{ id: "mail", health: "unknown", note: "mail_elsewhere" },
	],
};

let calls: Array<{ url: string; method: string }>;
let updates: unknown;

beforeEach(async () => {
	calls = [];
	updates = {
		cerea: {
			running: "0.51.2",
			state: "available",
			latest: "0.52.0",
			url: "https://github.com/paoloviviani/Cerea/releases/tag/v0.52.0",
		},
		pystino: {
			running: null,
			state: "unknown",
			latest: "0.34.0",
			url: "https://github.com/paoloviviani/Pystino/releases/tag/v0.34.0",
		},
	};
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET" });
			if (url.includes("/services/updates")) return Response.json(updates);
			if (url.includes("/api/v2/admin/services")) return Response.json(report);
			throw new Error(`unexpected fetch: ${url}`);
		})
	);
	await page.viewport(390, 800);
});
afterEach(() => {
	unmountRendered();
	vi.unstubAllGlobals();
});

describe("Services page", () => {
	it("shows a row per service with a word for its health, and its line", async () => {
		renderWithApp(Services, {});
		await expect.element(page.getByTestId("service-gateway")).toBeVisible();
		await expect.element(page.getByTestId("service-gateway")).toHaveTextContent("Working");
		await expect
			.element(page.getByTestId("service-embedding"))
			.toHaveTextContent("Needs attention");
		await expect
			.element(page.getByTestId("service-embedding"))
			.toHaveTextContent("emb-1 is chosen, but the gateway no longer lists it.");
		await expect.element(page.getByTestId("service-blobs")).toHaveTextContent("Not working");
		await expect.element(page.getByTestId("service-sandbox")).toHaveTextContent("Not configured");
		await expect.element(page.getByTestId("service-sandbox")).toHaveAttribute("data-health", "off");
		await expect.element(page.getByTestId("service-mail")).toHaveTextContent("Not checked");
	});

	it("fits a phone: no sideways scroll", async () => {
		renderWithApp(Services, {});
		await expect.element(page.getByTestId("service-gateway")).toBeVisible();
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
			document.documentElement.clientWidth
		);
	});

	it("loads without checking for updates, and Refresh asks for a fresh run", async () => {
		renderWithApp(Services, {});
		await expect.element(page.getByTestId("service-gateway")).toBeVisible();
		expect(calls.map((c) => c.url)).toEqual(["/api/v2/admin/services"]);
		await page.getByRole("button", { name: "Refresh" }).click();
		await vi.waitFor(() => expect(calls.at(-1)?.url).toBe("/api/v2/admin/services?refresh=1"));
		expect(calls.some((c) => c.url.includes("updates"))).toBe(false);
	});

	it("Check for updates posts once and shows newer, with a link to the release", async () => {
		renderWithApp(Services, {});
		await expect.element(page.getByTestId("service-gateway")).toBeVisible();
		await page.getByRole("button", { name: "Check for updates" }).click();
		await expect
			.element(page.getByTestId("update-cerea"))
			.toHaveTextContent("Cerea 0.52.0 is available. You run 0.51.2.");
		const link = page.getByRole("link", { name: "Release page" });
		await expect
			.element(link)
			.toHaveAttribute("href", "https://github.com/paoloviviani/Cerea/releases/tag/v0.52.0");
		await expect
			.element(page.getByTestId("update-pystino"))
			.toHaveTextContent("The running version is unknown");
		expect(calls.filter((c) => c.url.includes("updates"))).toEqual([
			{ url: "/api/v2/admin/services/updates", method: "POST" },
		]);
	});

	it("says up to date, and says plainly when GitHub cannot be reached", async () => {
		updates = {
			cerea: { running: "0.51.2", state: "current", latest: "0.51.2" },
			pystino: { running: "0.33.2", state: "offline" },
		};
		renderWithApp(Services, {});
		await expect.element(page.getByTestId("service-gateway")).toBeVisible();
		await page.getByRole("button", { name: "Check for updates" }).click();
		await expect
			.element(page.getByTestId("update-cerea"))
			.toHaveTextContent("Cerea 0.51.2: up to date.");
		await expect
			.element(page.getByTestId("update-pystino"))
			.toHaveTextContent("could not reach GitHub");
	});
});
