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
let posts: Array<{ url: string; body: Record<string, unknown> }>;
let putStatus = 200;

beforeEach(() => {
	puts = [];
	posts = [];
	putStatus = 200;
	extraServers = 0;
	vi.unstubAllGlobals();
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (init?.method === "PUT") {
				puts.push({ url, body: JSON.parse(String(init.body)) });
				return Response.json({}, { status: putStatus });
			}
			if (init?.method === "POST" && url.includes("/api/v2/mcp/connectors")) {
				posts.push({ url, body: JSON.parse(String(init.body)) });
				return Response.json({});
			}
			if (url.includes("/api/mcp/servers")) {
				const more = Array.from({ length: extraServers }, (_, i) => ({
					id: `base-extra-${i}`,
					key: `base:extra-${i}`,
					name: `extra-${i}`,
					url: `https://extra-${i}.test/mcp`,
					type: "base",
					mode: "on",
					alwaysLoaded: false,
				}));
				return Response.json([...ENV, ...more]);
			}
			if (url.includes("/api/v2/mcp/connectors")) return Response.json({ data: [NOTION] });
			return Response.json({});
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

let extraServers = 0;

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

	it("does not scroll or shift anything when an option is tapped on a phone", async () => {
		// The admin layout: a fixed shell that clips (`overflow-hidden`) around the one
		// scroller the page lives in. A tap on an option focuses its visually hidden radio,
		// and a focused element is scrolled into view in every ancestor that can scroll,
		// clipped ones included.
		await page.viewport(412, 800);
		extraServers = 10;
		const shell = document.createElement("div");
		shell.style.cssText =
			"position:fixed;inset:0;overflow:hidden;display:grid;grid-template-rows:1fr";
		const scroller = document.createElement("div");
		scroller.style.cssText = "min-height:0;overflow-y:auto";
		shell.append(scroller);
		document.body.append(shell);
		try {
			const screen = renderWithApp(Page, {} as never, { baseElement: scroller });
			await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
			const card = rows(screen.baseElement).at(-3) as HTMLElement;
			expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight + 300);
			scroller.scrollTop = card.offsetTop - 200;
			const scrollables = [scroller, shell, document.documentElement, document.body];
			const snapshot = () => ({
				scrolls: scrollables.map((el) => [el.scrollTop, el.scrollLeft]),
				card: card.getBoundingClientRect().top,
			});
			const before = snapshot();
			const option = card.querySelector<HTMLInputElement>('input[value="locked"]')
				?.parentElement as HTMLElement;
			await page.elementLocator(option).click();
			await vi.waitFor(() => expect(puts).toHaveLength(1));
			await new Promise((r) => setTimeout(r, 100));
			expect(snapshot()).toEqual(before);
		} finally {
			shell.remove();
		}
	});

	it("edits an added connector: name, address, description and a new key, through the admin API", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const card = screen.baseElement.querySelector(
			'[data-testid="shared-connector"]'
		) as HTMLElement;
		// The .env servers are edited in .env: no Edit on them.
		for (const row of rows(screen.baseElement)) {
			expect([...row.querySelectorAll("button")].map((b) => b.textContent?.trim())).not.toContain(
				"Edit"
			);
		}
		[...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit")?.click();
		const form = (await vi.waitFor(() => {
			const found = card.querySelector('[data-testid="edit-connector"]');
			expect(found).not.toBeNull();
			return found;
		})) as HTMLElement;
		const inputs = [...form.querySelectorAll("input")];
		const fill = async (input: HTMLInputElement, value: string) => {
			await page.elementLocator(input).fill(value);
		};
		// OAuth: a credential is each person's own, so there is no shared key field.
		expect(form.querySelector('input[type="password"]')).toBeNull();
		await fill(inputs[0], "Notion team");
		await fill(inputs[1], "https://notion.test/v2/mcp");
		await fill(inputs[2], "Our team notes.");
		[...form.querySelectorAll("button")]
			.find((b) => b.textContent?.trim() === "Save changes")
			?.click();
		await vi.waitFor(() =>
			expect(posts).toContainEqual({
				url: expect.stringContaining("/api/v2/mcp/connectors/c-gui?scope=deployment"),
				body: {
					action: "update",
					name: "Notion team",
					url: "https://notion.test/v2/mcp",
					description: "Our team notes.",
				},
			})
		);
	});

	it("sends a replaced shared key with its header, and 'remove' clears it", async () => {
		const original = globalThis.fetch;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				if (url.includes("/api/v2/mcp/connectors") && (init?.method ?? "GET") === "GET") {
					return Response.json({
						data: [{ ...NOTION, id: "c-key", auth: "token", tokenHeader: "X-API-Key" }],
					});
				}
				return original(input, init);
			})
		);
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const card = screen.baseElement.querySelector(
			'[data-testid="shared-connector"]'
		) as HTMLElement;
		[...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit")?.click();
		const form = (await vi.waitFor(() => {
			const found = card.querySelector('[data-testid="edit-connector"]');
			expect(found).not.toBeNull();
			return found;
		})) as HTMLElement;
		await page
			.elementLocator(form.querySelector('input[type="password"]') as HTMLElement)
			.fill("new-key");
		[...form.querySelectorAll("button")]
			.find((b) => b.textContent?.trim() === "Save changes")
			?.click();
		await vi.waitFor(() =>
			expect(posts.at(-1)?.body).toMatchObject({
				action: "update",
				token: "new-key",
				tokenHeader: "X-API-Key",
				tokenPrefix: "",
			})
		);
	});

	it("shows N tools, 'not checked yet' or the error on every added card, and Check calls the admin API", async () => {
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const card = screen.baseElement.querySelector(
			'[data-testid="shared-connector"]'
		) as HTMLElement;
		expect(card.querySelector('[data-testid="tools-status"]')?.textContent?.trim()).toBe(
			"Tools not checked yet"
		);
		[...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Check")?.click();
		await vi.waitFor(() =>
			expect(posts).toContainEqual({
				url: expect.stringContaining("/api/v2/mcp/connectors/c-gui?scope=deployment"),
				body: { action: "check" },
			})
		);
	});

	it("sends the description of a connector being added", async () => {
		renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		await page.getByRole("button", { name: "Add", exact: true }).click();
		await page.getByLabelText("Name").fill("Find locations");
		await page.getByLabelText("URL").fill("https://api.example.test/mcp");
		await page.getByLabelText("Description").fill("Finds places.");
		await page.getByRole("button", { name: "Add for everyone" }).click();
		await vi.waitFor(() =>
			expect(posts).toContainEqual({
				url: expect.stringContaining("/api/v2/mcp/connectors"),
				body: expect.objectContaining({
					name: "Find locations",
					description: "Finds places.",
					scope: "deployment",
				}),
			})
		);
	});

	it("fits a phone: the edit form has no horizontal scroll at 390px", async () => {
		await page.viewport(390, 800);
		const screen = renderWithApp(Page, {} as never);
		await expect.element(page.getByText("Notion", { exact: true })).toBeInTheDocument();
		const card = screen.baseElement.querySelector(
			'[data-testid="shared-connector"]'
		) as HTMLElement;
		[...card.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Edit")?.click();
		const form = (await vi.waitFor(() => {
			const found = card.querySelector('[data-testid="edit-connector"]');
			expect(found).not.toBeNull();
			return found;
		})) as HTMLElement;
		expect(form.scrollWidth).toBeLessThanOrEqual(form.clientWidth);
		expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
	});
});
