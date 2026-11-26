import { describe, expect, it, vi } from "vitest";
import {
	currentWindowId,
	desktopBrowser,
	startDesktopBrowserLink,
	type CereaDesktopBrowser,
} from "./desktopBrowser";

class FakeSocket {
	static all: FakeSocket[] = [];
	readyState = 0;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onclose: ((e: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	constructor(
		readonly url: string,
		readonly protocols: string[] = []
	) {
		FakeSocket.all.push(this);
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	send(t: string) {
		this.sent.push(t);
	}
	close() {
		this.readyState = 3;
		this.onclose?.({ code: 1000 });
	}
}

function bridge() {
	const toApp: string[] = [];
	let cb: ((j: string) => void) | undefined;
	const b: CereaDesktopBrowser = {
		available: true,
		send: (j) => void toApp.push(j),
		onMessage: (fn) => {
			cb = fn;
			return () => {
				cb = undefined;
			};
		},
	};
	return { b, toApp, fromApp: (j: string) => cb?.(j), listening: () => cb !== undefined };
}

const okTicket = (ticket = "T1") =>
	vi.fn(async () => new Response(JSON.stringify({ ticket }), { status: 200 }));

describe("desktopBrowser", () => {
	it("is only there when the app says it can run a browser", () => {
		expect(desktopBrowser({} as never)).toBeUndefined();
		expect(desktopBrowser({ cereaDesktop: {} } as never)).toBeUndefined();
		expect(
			desktopBrowser({ cereaDesktop: { browser: { available: false } } } as never)
		).toBeUndefined();
		const b = bridge().b;
		expect(desktopBrowser({ cereaDesktop: { browser: b } } as never)).toBe(b);
	});

	it("does nothing outside the app", () => {
		const fetchFn = vi.fn();
		const stop = startDesktopBrowserLink({
			base: "",
			fetchFn: fetchFn as never,
			bridge: undefined,
			origin: "https://c",
		});
		// no `window` bridge in this environment
		expect(fetchFn).not.toHaveBeenCalled();
		stop();
	});

	it("opens the socket with a ticket and relays text both ways without reading it", async () => {
		FakeSocket.all = [];
		const { b, toApp, fromApp } = bridge();
		const fetchFn = okTicket();
		const stop = startDesktopBrowserLink({
			base: "/chat",
			bridge: b,
			fetchFn: fetchFn as never,
			socketFactory: (u, p) => new FakeSocket(u, p) as never,
			origin: "https://cerea.example",
			windowId: "i".repeat(32),
		});
		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		expect(fetchFn).toHaveBeenCalledWith(
			"/chat/api/v2/browser/window/ticket",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ windowId: "i".repeat(32) }),
			})
		);
		const ws = FakeSocket.all[0];
		expect(ws.url).toBe("wss://cerea.example/chat/api/v2/browser/window");
		expect(ws.protocols).toEqual(["cerea-window.v1", "ticket.T1"]);
		expect(currentWindowId()).toBeUndefined(); // not until it is open
		ws.open();
		expect(currentWindowId()).toBe("i".repeat(32));
		// the page tells the app which window it is: no secret and no cookie name
		expect(toApp).toEqual([
			JSON.stringify({
				jsonrpc: "2.0",
				method: "cerea/window",
				params: { windowId: "i".repeat(32) },
			}),
		]);
		toApp.length = 0;
		ws.onmessage?.({ data: '{"down":1}' });
		ws.onmessage?.({ data: new ArrayBuffer(4) }); // binary is never passed on
		expect(toApp).toEqual(['{"down":1}']);
		fromApp('{"up":1}');
		expect(ws.sent).toEqual(['{"up":1}']);
		stop();
		expect(currentWindowId()).toBeUndefined();
	});

	it("does not retry when the server says no (off, signed out), and retries when the network fails", async () => {
		for (const status of [401, 403, 404]) {
			const fetchFn = vi.fn(async () => new Response("", { status }));
			startDesktopBrowserLink({
				base: "",
				bridge: bridge().b,
				fetchFn: fetchFn as never,
				socketFactory: () => {
					throw new Error("no socket expected");
				},
				origin: "https://c",
				backoff: [5, 5],
			});
			await new Promise((r) => setTimeout(r, 40));
			expect(fetchFn).toHaveBeenCalledTimes(1);
		}
		let n = 0;
		const flaky = vi.fn(async () => {
			if (++n === 1) throw new Error("offline");
			return new Response(JSON.stringify({ ticket: "T2" }), { status: 200 });
		});
		FakeSocket.all = [];
		const stop = startDesktopBrowserLink({
			base: "",
			bridge: bridge().b,
			fetchFn: flaky as never,
			socketFactory: (u, p) => new FakeSocket(u, p) as never,
			origin: "https://c",
			backoff: [5, 5],
		});
		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		stop();
	});

	it("reconnects when the socket drops, but not when a newer connection replaced it", async () => {
		FakeSocket.all = [];
		const { b } = bridge();
		const fetchFn = okTicket();
		const stop = startDesktopBrowserLink({
			base: "",
			bridge: b,
			fetchFn: fetchFn as never,
			socketFactory: (u, p) => new FakeSocket(u, p) as never,
			origin: "https://c",
			windowId: "j".repeat(32),
			backoff: [5, 5],
		});
		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(1));
		FakeSocket.all[0].open();
		FakeSocket.all[0].onclose?.({ code: 1006 });
		expect(currentWindowId()).toBeUndefined();
		await vi.waitFor(() => expect(FakeSocket.all).toHaveLength(2));
		FakeSocket.all[1].open();
		FakeSocket.all[1].onclose?.({ code: 4409 });
		await new Promise((r) => setTimeout(r, 40));
		expect(FakeSocket.all).toHaveLength(2);
		stop();
	});
});
