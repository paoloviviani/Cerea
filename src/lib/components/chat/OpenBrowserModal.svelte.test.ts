/**
 * "Open browser…" (ADR 0116, C109): an optional address and the ready computers, default first.
 * One computer is a single button; several are listed as a menu. Choosing opens the page there,
 * tied to the conversation when there is one, and says "Opened on <computer>".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenBrowserModal from "./OpenBrowserModal.svelte";
import { renderWithApp } from "$lib/components/__tests__/renderWithApp";
import { NOTIFICATIONS_CONTEXT_KEY } from "$lib/stores/notifications.svelte";

vi.mock("$env/dynamic/public", () => ({ env: { PUBLIC_APP_NAME: "chat-ui" } }));

const laptop = { id: "d1", name: "Laptop", default: false, current: false };
const desk = { id: "d2", name: "Desk", default: true, current: false };

let calls: Array<{ url: string; body: Record<string, unknown> }>;
let respond: (call: { url: string }) => Response;
beforeEach(() => {
	pushMessage.mockReset();
	calls = [];
	respond = () =>
		Response.json({ opened: true, computer: "Desk", title: "", url: "about:blank", tied: true });
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
			return respond({ url: String(url) });
		})
	);
});
afterEach(() => vi.unstubAllGlobals());

const pushMessage = vi.fn();
const mount = (props: Record<string, unknown>) =>
	renderWithApp(OpenBrowserModal, { open: true, ...props } as never, {
		context: new Map([[NOTIFICATIONS_CONTEXT_KEY, { pushMessage }]]),
	});
const buttons = () => [
	...document.body.querySelectorAll<HTMLButtonElement>('[data-testid="open-browser-computer"]'),
];

describe("OpenBrowserModal", () => {
	it("lists several computers with the default marked, in the order given (default first)", async () => {
		mount({ computers: [desk, laptop], conversationId: "conv1" });
		await vi.waitFor(() => expect(buttons()).toHaveLength(2));
		expect(buttons().map((b) => b.textContent?.replace(/\s+/g, " ").trim())).toEqual([
			"Desk Default",
			"Laptop",
		]);
		expect(document.body.textContent).toContain("Which computer?");
	});

	it("with one computer asks nothing: a single Open on button", async () => {
		mount({ computers: [laptop] });
		await vi.waitFor(() => expect(buttons()).toHaveLength(1));
		expect(buttons()[0].textContent).toContain("Open on Laptop");
		expect(document.body.textContent).not.toContain("Which computer?");
	});

	it("opens on the chosen computer with the address, tied to the conversation, and says where", async () => {
		mount({ computers: [desk, laptop], conversationId: "conv1" });
		const input = document.body.querySelector<HTMLInputElement>("#open-browser-address");
		if (!input) throw new Error("address field missing");
		input.value = "shop.example.com";
		input.dispatchEvent(new Event("input", { bubbles: true }));
		buttons()[1].click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0].url).toContain("/api/v2/browser/open");
		expect(calls[0].body).toEqual({
			deviceId: "d1",
			url: "shop.example.com",
			conversationId: "conv1",
		});
		await vi.waitFor(() =>
			expect(document.body.querySelector('[data-testid="open-browser-modal"]')).toBeNull()
		);
		expect(pushMessage).toHaveBeenCalledWith("Opened on Laptop");
	});

	it("sends no address and no conversation when there are none (the home page)", async () => {
		mount({ computers: [laptop] });
		await vi.waitFor(() => expect(buttons()).toHaveLength(1));
		buttons()[0].click();
		await vi.waitFor(() => expect(calls).toHaveLength(1));
		expect(calls[0].body).toEqual({ deviceId: "d1" });
		expect(document.body.textContent).toContain("own tabs");
	});

	it("keeps the dialog open and shows the server's reason when it is busy", async () => {
		respond = () =>
			Response.json(
				{
					error: "busy",
					message: "The browser on Laptop is busy with a task. Try again when it finishes.",
				},
				{ status: 409 }
			);
		mount({ computers: [laptop], conversationId: "conv1" });
		await vi.waitFor(() => expect(buttons()).toHaveLength(1));
		buttons()[0].click();
		await vi.waitFor(() => expect(document.body.textContent).toContain("is busy with a task"));
		expect(document.body.querySelector('[data-testid="open-browser-modal"]')).not.toBeNull();
		// Free to try again.
		expect(buttons()[0].disabled).toBe(false);
	});
});
