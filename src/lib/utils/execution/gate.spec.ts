import { describe, expect, it, vi } from "vitest";
import { ALLOWED_PATH_PREFIX, gateAllows, installNetworkGate } from "./gate";

describe("network gate", () => {
	it("allows same-origin /pyodide/ paths and nothing else", () => {
		const origin = "https://chat.example.org";
		expect(gateAllows("/pyodide/pyodide.asm.wasm", origin)).toBe(true);
		expect(gateAllows("/pyodide/wheels/numpy-1.0.whl", origin)).toBe(true);
		expect(gateAllows("https://chat.example.org/pyodide/python_stdlib.zip", origin)).toBe(true);
		// A different path on the app origin would carry the session cookie.
		expect(gateAllows("/api/v2/user", origin)).toBe(false);
		// The public Pyodide package index is the default micropip target.
		expect(gateAllows("https://python.pyodide.org/pyodide/pyodide-lock.json", origin)).toBe(false);
		expect(gateAllows("https://evil.example/leak?d=secret", origin)).toBe(false);
	});

	it("installs an allowlisted fetch and removes the other network surfaces", async () => {
		const inner = vi.fn(() => Promise.resolve(new Response("ok")));
		const scope = {
			location: {
				href: "https://chat.example.org/_app/immutable/worker.js",
				origin: "https://chat.example.org",
			},
			fetch: inner,
			navigator: { sendBeacon: vi.fn(), serviceWorker: {} },
			XMLHttpRequest: function X() {},
			WebSocket: function W() {},
			Worker: function Nw() {},
		} as unknown as typeof globalThis;

		installNetworkGate(scope);

		expect(scope.XMLHttpRequest).toBeUndefined();
		expect(scope.Worker).toBeUndefined();
		expect(scope.navigator.sendBeacon).toBeUndefined();

		// Inside the allowlist: proxied to the real fetch.
		await scope.fetch(`${ALLOWED_PATH_PREFIX}pyodide.mjs`);
		expect(inner).toHaveBeenCalledTimes(1);

		// Outside it: rejected without touching the network.
		await expect(scope.fetch("https://evil.example/x")).rejects.toThrow(/execution sandbox/);
		expect(inner).toHaveBeenCalledTimes(1);
	});
});
