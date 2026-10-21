import { describe, expect, it, vi } from "vitest";
import type dns from "node:dns";
import { guardedLookup, isInternalAddress, isPushEndpointAllowed, pushFetch } from "./guard";

describe("isPushEndpointAllowed", () => {
	it("takes a public https host", () => {
		expect(isPushEndpointAllowed("https://fcm.googleapis.com/fcm/send/abc")).toBe(true);
		expect(isPushEndpointAllowed("https://203.0.113.9/x")).toBe(true);
	});
	it("refuses http and every private literal", () => {
		for (const u of [
			"http://fcm.googleapis.com/x",
			"https://10.0.0.5/x",
			"https://100.64.1.1/x",
			"https://127.0.0.1/x",
			"https://169.254.169.254/x",
			"https://172.16.0.1/x",
			"https://192.168.1.1/x",
			"https://[::1]/x",
			"https://[fe80::1]/x",
			"https://[fc00::1]/x",
			"https://[::ffff:10.0.0.1]/x",
			"https://[::ffff:7f00:1]/x",
			"https://localhost/x",
			"nonsense",
		]) {
			expect(isPushEndpointAllowed(u), u).toBe(false);
		}
	});
});

describe("guardedLookup", () => {
	const resolves = (address: string) =>
		((_h: string, _o: unknown, cb: (e: null, a: string, f: number) => void) =>
			cb(null, address, 4)) as unknown as typeof dns.lookup;

	it("refuses a hostname that resolves to 10.x (rebinding)", () => {
		const cb = vi.fn();
		guardedLookup("push.example.net", {}, cb, resolves("10.2.3.4"));
		expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
	});
	it("refuses when any answer of a list is internal", () => {
		const cb = vi.fn();
		const many = ((_h: string, _o: unknown, c: (e: null, a: unknown) => void) =>
			c(null, [
				{ address: "203.0.113.9", family: 4 },
				{ address: "10.0.0.1", family: 4 },
			])) as unknown as typeof dns.lookup;
		guardedLookup("push.example.net", { all: true }, cb, many);
		expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
	});
	it("lets a public answer through", () => {
		const cb = vi.fn();
		guardedLookup("push.example.net", {}, cb, resolves("203.0.113.9"));
		expect(cb).toHaveBeenCalledWith(null, "203.0.113.9", 4);
	});
});

describe("pushFetch", () => {
	it("refuses before connecting to a private literal or http", async () => {
		await expect(pushFetch("https://10.0.0.5/x", { method: "POST" })).rejects.toThrow();
		await expect(pushFetch("http://push.example.net/x", { method: "POST" })).rejects.toThrow();
	});
});

describe("isInternalAddress", () => {
	it("is true for the unparseable", () => expect(isInternalAddress("zzz")).toBe(true));
});
