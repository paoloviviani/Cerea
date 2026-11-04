/**
 * The Workspace card for a connector where each user brings their own key: Add your key
 * (the administrator's help, a password field, Save), then Connected with Replace key / Check
 * key / Remove key; a refused key says so. The key is typed and sent, never shown again.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { page } from "@vitest/browser/context";

import ConnectorsSection from "./ConnectorsSection.svelte";
import type { McpConnectorView } from "$lib/types/McpConnector";
import { connectors } from "$lib/stores/mcpConnectors";
import { allMcpServers } from "$lib/stores/mcpServers";
import { renderWithApp } from "../__tests__/renderWithApp";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

function keyed(overrides: Partial<McpConnectorView> = {}): McpConnectorView {
	return {
		id: "c-key",
		key: "connector:c-key",
		enabled: true,
		name: "GitHub",
		url: "https://github.test/mcp",
		auth: "user-key",
		scope: "deployment",
		manageable: false,
		connected: false,
		canAuthorize: false,
		tokenHeader: "Authorization",
		keyHelpText: "Create a token with the repo scope.",
		keyHelpUrl: "https://github.test/tokens",
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

let seen: { method: string; url: string; body?: Record<string, unknown> }[];
let current: McpConnectorView;

function stubApi() {
	vi.stubGlobal("confirm", () => true);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			if (url.includes("/api/v2/mcp/connectors") && method === "GET") {
				return Response.json({ data: [current] });
			}
			seen.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
			return Response.json({});
		})
	);
}

const buttons = (root: HTMLElement) =>
	[...root.querySelectorAll("button")].map((b) => b.textContent?.trim());

describe("a user-key connector card in Workspace", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		connectors.set([]);
		allMcpServers.set([]);
		seen = [];
	});

	it("before a key: Add your key, no use switch on, and no Check or Remove", async () => {
		current = keyed();
		stubApi();
		const screen = renderWithApp(ConnectorsSection, { onclose: () => {} } as never);
		await expect.element(screen.getByText("GitHub", { exact: true })).toBeInTheDocument();
		expect(buttons(screen.baseElement)).toContain("Add your key");
		expect(buttons(screen.baseElement)).not.toContain("Check key");
		expect(buttons(screen.baseElement)).not.toContain("Remove key");
		expect(screen.baseElement.textContent).toContain("No key yet");
		const toggle = screen.baseElement.querySelector(
			'input[name="use-connector-c-key"]'
		) as HTMLInputElement | null;
		if (toggle) expect(toggle.disabled).toBe(true);
	});

	it("Add your key opens the administrator's help and a password field; Save sends it and clears it", async () => {
		current = keyed();
		stubApi();
		const screen = renderWithApp(ConnectorsSection, { onclose: () => {} } as never);
		await expect.element(screen.getByText("GitHub", { exact: true })).toBeInTheDocument();
		await page.getByRole("button", { name: "Add your key" }).click();

		await expect.element(page.getByText("Create a token with the repo scope.")).toBeInTheDocument();
		const link = screen.baseElement.querySelector(
			'a[href="https://github.test/tokens"]'
		) as HTMLAnchorElement;
		expect(link.rel).toContain("noopener");
		const field = screen.baseElement.querySelector(
			'[data-testid="key-form"] input[type="password"]'
		) as HTMLInputElement;
		expect(field.autocomplete).toBe("off");
		await page.elementLocator(field).fill("ghp_secret_value");
		await page.getByRole("button", { name: "Save", exact: true }).click();

		await vi.waitFor(() =>
			expect(seen).toContainEqual({
				method: "POST",
				url: "/api/v2/mcp/connectors/c-key",
				body: { action: "setKey", key: "ghp_secret_value" },
			})
		);
		// The form closes and nothing on the page holds the key any more.
		await vi.waitFor(() =>
			expect(screen.baseElement.querySelector('[data-testid="key-form"]')).toBeNull()
		);
		expect(screen.baseElement.innerHTML).not.toContain("ghp_secret_value");
	});

	it("once connected: Connected, Replace key, Check key and Remove key; Remove key asks and disconnects", async () => {
		current = keyed({ connected: true });
		stubApi();
		const screen = renderWithApp(ConnectorsSection, { onclose: () => {} } as never);
		await expect.element(screen.getByText("GitHub", { exact: true })).toBeInTheDocument();
		expect(screen.baseElement.textContent).toContain("Connected");
		expect(buttons(screen.baseElement)).toEqual(
			expect.arrayContaining(["Replace key", "Check key", "Remove key"])
		);
		expect(buttons(screen.baseElement)).not.toContain("Add your key");

		await page.getByRole("button", { name: "Check key" }).click();
		await vi.waitFor(() =>
			expect(seen).toContainEqual(expect.objectContaining({ body: { action: "checkKey" } }))
		);
		await page.getByRole("button", { name: "Remove key" }).click();
		await vi.waitFor(() =>
			expect(seen).toContainEqual(expect.objectContaining({ body: { action: "disconnect" } }))
		);
	});

	it("a refused key says so, offers Replace key, and points at it", async () => {
		current = keyed({ keyRefused: true });
		stubApi();
		const screen = renderWithApp(ConnectorsSection, { onclose: () => {} } as never);
		await expect.element(page.getByTestId("key-refused")).toHaveTextContent("Your key was refused");
		expect(buttons(screen.baseElement)).toContain("Replace key");
		expect(buttons(screen.baseElement)).not.toContain("Add your key");
		expect(screen.baseElement.textContent).toContain("Replace it to use this connector");
	});
});
