/**
 * The admin Connectors page (ADR 0104): the servers `.env` defines (their address stays in
 * `.env`, read-only) beside the connectors an administrator adds, and for each one how it is
 * offered: off, on, or on and locked, and whether it is always loaded.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { page } from "@vitest/browser/context";

import Page from "./+page.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const NOTION = {
	id: "c-gui",
	key: "connector:c-gui",
	enabled: true,
	name: "Notion",
	url: "https://notion.test/mcp",
	auth: "oauth",
	scope: "deployment",
	manageable: true,
	connected: false,
	canAuthorize: true,
	mode: "on",
	alwaysLoaded: false,
	updatedAt: new Date().toISOString(),
};
const ENV = [
	{
		id: "base-search",
		key: "base:search",
		name: "search",
		url: "https://search.test/mcp",
		type: "base",
		mode: "on",
		alwaysLoaded: false,
	},
	{
		id: "base-osm",
		key: "base:osm",
		name: "osm",
		url: "https://osm.test/mcp",
		type: "base",
		mode: "off",
		alwaysLoaded: false,
	},
];

let puts: Array<{ url: string; body: Record<string, unknown> }>;
let putStatus = 200;

beforeEach(() => {
	puts = [];
	putStatus = 200;
	vi.unstubAllGlobals();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "PUT") {
				puts.push({ url, body: JSON.parse(String(init.body)) });
				return Response.json({}, { status: putStatus });
			}
			if (url.includes("/api/mcp/servers")) return Response.json(ENV);
			if (url.includes("/api/v2/mcp/connectors")) return Response.json({ data: [NOTION] });
			return Response.json({});
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

const rows = (root: HTMLElement) => [...root.querySelectorAll('[data-testid="env-server"]')];

describe("admin MCP page", () => {
	it("lists .env servers read-only next to the deployment connectors, off ones included", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const found = rows(screen.baseElement);
		expect(found.map((r) => r.querySelector("p")?.textContent)).toEqual(["osm", "search"]);
		expect(found[1].textContent).toContain("Set in the .env file");
		// Read-only: the only Remove on the page is the added connector's.
		const removes = [...screen.baseElement.querySelectorAll("button")].filter((b) =>
			b.textContent?.includes("Remove")
		);
		expect(removes).toHaveLength(1);
		expect(screen.baseElement.textContent).toContain("edit them there");
	});

	it("shows each connector's mode, with a line saying what it means", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const [osm, search] = rows(screen.baseElement);
		expect(osm.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("off");
		expect(osm.querySelector('[data-testid="mode-hint"]')?.textContent).toContain(
			"Not offered to anyone"
		);
		expect(search.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("on");
		expect(search.querySelector('[data-testid="mode-hint"]')?.textContent).toContain(
			"switch it off"
		);
	});

	it("changes a .env server's mode and an added connector's, on the server", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const [, search] = rows(screen.baseElement);
		search.querySelector<HTMLInputElement>('input[type="radio"][value="locked"]')?.click();
		await vi.waitFor(() =>
			expect(puts).toContainEqual({
				url: expect.stringContaining("/api/v2/admin/connector-modes"),
				body: { kind: "base", name: "search", mode: "locked" },
			})
		);
		await vi.waitFor(() =>
			expect(search.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe(
				"locked"
			)
		);

		const notion = screen.baseElement.querySelector(
			'[data-testid="shared-connector"]'
		) as HTMLElement;
		notion.querySelector<HTMLInputElement>('input[type="radio"][value="off"]')?.click();
		await vi.waitFor(() =>
			expect(puts).toContainEqual({
				url: expect.stringContaining("/api/v2/admin/connector-modes"),
				body: { kind: "connector", id: "c-gui", mode: "off" },
			})
		);
	});

	it("sets 'always loaded' with its own switch, and says what it costs", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		expect(screen.baseElement.textContent).toContain("keep big or rarely used connectors off");
		const [, search] = rows(screen.baseElement);
		search.querySelector<HTMLInputElement>('input[name="loaded-base-search"]')?.click();
		await vi.waitFor(() =>
			expect(puts).toContainEqual({
				url: expect.stringContaining("/api/v2/admin/connector-modes"),
				body: { kind: "base", name: "search", alwaysLoaded: true },
			})
		);
	});

	it("puts a mode back and says so when the server refuses it", async () => {
		putStatus = 500;
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const [, search] = rows(screen.baseElement);
		search.querySelector<HTMLInputElement>('input[type="radio"][value="locked"]')?.click();
		await expect.element(page.getByText("Could not change it. Try again.")).toBeInTheDocument();
		expect(search.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value).toBe("on");
	});
});
