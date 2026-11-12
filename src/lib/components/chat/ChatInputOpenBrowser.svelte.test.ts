/**
 * The composer's + menu, "Open browser…" (ADR 0116, C109): shown only when browser use is on and
 * at least one computer has its browser ready; it opens the dialog that tied the page to this chat.
 */
import ChatInput from "./ChatInput.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writable } from "svelte/store";

vi.mock("$env/dynamic/public", () => ({
	env: { PUBLIC_APP_ASSETS: "chatui", PUBLIC_APP_NAME: "chat-ui" },
}));

const waitSlow = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 5000 });
const CONV_ID = "0123456789abcdef01234567";
const settingsContext = new Map<string, unknown>([["settings", writable({ activeModel: "m" })]]);

let computers: Array<{ id: string; name: string; default: boolean; current: boolean }>;
let computerCalls: string[];

beforeEach(() => {
	document.getElementById("app")?.remove();
	computers = [];
	computerCalls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL) => {
			const href = String(url);
			if (href.includes("/api/v2/browser/computers")) {
				computerCalls.push(href);
				return Response.json({ computers });
			}
			if (href.includes("/api/v2/mcp/connectors")) return Response.json({ data: [] });
			if (href.includes("vector_stores")) return Response.json({ data: [] });
			return new Response("{}", { status: 404 });
		})
	);
});
afterEach(() => {
	vi.unstubAllGlobals();
	document.getElementById("app")?.remove();
});

async function mount(
	pageData: Record<string, unknown>,
	params: Record<string, string> = { id: CONV_ID }
) {
	const host = document.createElement("div");
	host.id = "app";
	document.body.appendChild(host);
	renderWithApp(
		ChatInput,
		{ mimeTypes: ["text/plain"] },
		{
			page: { params, data: { user: { username: "tester" }, loginEnabled: true, ...pageData } },
			baseElement: host,
			context: settingsContext,
		}
	);
	return host;
}

const openMenu = async (host: HTMLElement) => {
	const trigger = host.querySelector<HTMLElement>('button[aria-label="Add attachment"]')!;
	trigger.focus();
	trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	await waitSlow(() => {
		const menu = document.body.querySelector('[role="menu"]');
		expect(menu?.textContent).toContain("Add file");
		expect(menu?.contains(document.activeElement)).toBe(true);
	});
};
const item = () => document.body.querySelector<HTMLElement>('[data-testid="open-browser-item"]');

describe("ChatInput: Open browser…", () => {
	it("is shown when browser use is on and a computer's browser is ready", async () => {
		computers = [{ id: "d1", name: "Laptop", default: true, current: false }];
		const host = await mount({ browserUseEnabled: true });
		await waitSlow(() => expect(computerCalls.length).toBeGreaterThan(0));
		await openMenu(host);
		await waitSlow(() => expect(item()).not.toBeNull());
		expect(item()?.textContent).toContain("Open browser…");
		// It asks about this conversation.
		expect(computerCalls[0]).toContain(`conversationId=${CONV_ID}`);
	});

	it("is not shown when no computer has a ready browser", async () => {
		const host = await mount({ browserUseEnabled: true });
		await waitSlow(() => expect(computerCalls.length).toBeGreaterThan(0));
		await openMenu(host);
		expect(item()).toBeNull();
	});

	it("is not shown, and nothing is fetched, when browser use is off", async () => {
		computers = [{ id: "d1", name: "Laptop", default: false, current: false }];
		const host = await mount({});
		await openMenu(host);
		expect(item()).toBeNull();
		expect(computerCalls).toEqual([]);
	});

	it("opens the dialog with the computers, default first", async () => {
		computers = [
			{ id: "d2", name: "Desk", default: true, current: false },
			{ id: "d1", name: "Laptop", default: false, current: false },
		];
		const host = await mount({ browserUseEnabled: true });
		await waitSlow(() => expect(computerCalls.length).toBeGreaterThan(0));
		await openMenu(host);
		await waitSlow(() => expect(item()).not.toBeNull());
		item()?.click();
		await waitSlow(() =>
			expect(document.body.querySelector('[data-testid="open-browser-modal"]')).not.toBeNull()
		);
		const names = [...document.body.querySelectorAll('[data-testid="open-browser-computer"]')].map(
			(b) => b.textContent?.replace(/\s+/g, " ").trim()
		);
		expect(names).toEqual(["Desk Default", "Laptop"]);
	});
});
