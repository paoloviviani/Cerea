import { afterEach, describe, expect, it, vi } from "vitest";

/** Runs the Cerea view's preload against stand-ins for the page and for Electron. */
async function runPreload(opts: {
	origin: string;
	arg?: string;
	top?: boolean;
	available?: boolean;
}) {
	vi.resetModules();
	const exposed: Record<string, unknown> = {};
	const sent: unknown[][] = [];
	const handlers: Record<string, (e: unknown, ...a: unknown[]) => void> = {};
	vi.doMock("electron", () => ({
		contextBridge: { exposeInMainWorld: (k: string, v: unknown) => (exposed[k] = v) },
		ipcRenderer: {
			sendSync: (ch: string) =>
				ch === "winbrowser:available" ? (opts.available ?? true) : undefined,
			send: (...a: unknown[]) => sent.push(a),
			on: (ch: string, h: (e: unknown, ...a: unknown[]) => void) => (handlers[ch] = h),
		},
	}));
	const win: Record<string, unknown> = {};
	win.top = opts.top === false ? {} : win;
	vi.stubGlobal("window", win);
	vi.stubGlobal("location", { origin: opts.origin });
	const argv = process.argv;
	process.argv = [...argv, ...(opts.arg ? [opts.arg] : [])];
	try {
		await import("../src/preload/cerea.ts");
	} finally {
		process.argv = argv;
	}
	return { exposed, sent, handlers };
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.doUnmock("electron");
});

const ORIGIN = "https://cerea.example";

describe("the Cerea view's preload", () => {
	it("exposes the browser bridge on the profile's origin, in the main frame", async () => {
		const { exposed, sent, handlers } = await runPreload({
			origin: ORIGIN,
			arg: `--cerea-origin=${ORIGIN}`,
		});
		const b = (exposed.cereaDesktop as { browser: Record<string, unknown> }).browser;
		expect(Object.keys(b).sort()).toEqual(["available", "onMessage", "send"]);
		expect(b.available).toBe(true);
		(b.send as (j: unknown) => void)('{"jsonrpc":"2.0"}');
		(b.send as (j: unknown) => void)({ not: "text" });
		(b.send as (j: unknown) => void)("x".repeat(300 * 1024));
		expect(sent).toEqual([["winbrowser:send", '{"jsonrpc":"2.0"}']]);
		const got: string[] = [];
		const off = (b.onMessage as (cb: (j: string) => void) => () => void)((j) => got.push(j));
		handlers["winbrowser:message"]({}, "hello");
		handlers["winbrowser:message"]({}, { object: true });
		off();
		handlers["winbrowser:message"]({}, "after");
		expect(got).toEqual(["hello"]);
	});
	it("reports not available when the app cannot run a browser, and sends nothing", async () => {
		const { exposed, sent } = await runPreload({
			origin: ORIGIN,
			arg: `--cerea-origin=${ORIGIN}`,
			available: false,
		});
		const b = (exposed.cereaDesktop as { browser: { available: boolean; send(j: string): void } })
			.browser;
		expect(b.available).toBe(false);
		b.send("{}");
		expect(sent).toEqual([]);
	});
	it("exposes nothing on another origin (the identity provider), in a subframe, or without an origin", async () => {
		for (const o of [
			{ origin: "https://idp.example", arg: `--cerea-origin=${ORIGIN}` },
			{ origin: "https://cerea.example.evil.test", arg: `--cerea-origin=${ORIGIN}` },
			{ origin: ORIGIN, arg: `--cerea-origin=${ORIGIN}`, top: false },
			{ origin: ORIGIN },
			{ origin: "null", arg: `--cerea-origin=${ORIGIN}` },
		]) {
			expect((await runPreload(o)).exposed).toEqual({});
		}
	});
});
