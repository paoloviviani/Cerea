import { describe, expect, it, vi } from "vitest";
import { gateAllows, installNetworkGate } from "./gate";
import { pyodideBasePath } from "./protocol";

describe("network gate", () => {
	it("allows same-origin /pyodide/ paths and nothing else", () => {
		// Defaults follow the build base, which is "/" under vitest.
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

		// Inside the allowlist: proxied to the real fetch. The expected
		// prefix is derived the same way the gate's default is, so this
		// exercises the default wiring rather than a literal.
		const expectedPrefix = pyodideBasePath(
			(import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL
		);
		await scope.fetch(`${expectedPrefix}pyodide.mjs`);
		expect(inner).toHaveBeenCalledTimes(1);

		// Outside it: rejected without touching the network.
		await expect(scope.fetch("https://evil.example/x")).rejects.toThrow(/execution sandbox/);
		expect(inner).toHaveBeenCalledTimes(1);
	});

	it("resolves the runtime prefix from the app base", () => {
		expect(pyodideBasePath("/")).toBe("/pyodide/");
		expect(pyodideBasePath("")).toBe("/pyodide/");
		expect(pyodideBasePath(undefined)).toBe("/pyodide/");
		expect(pyodideBasePath("/chat")).toBe("/chat/pyodide/");
		expect(pyodideBasePath("/chat/")).toBe("/chat/pyodide/");
	});

	it("gates on <base>/pyodide/ under a base path", () => {
		const origin = "https://chat.example.org";
		const prefix = pyodideBasePath("/chat");
		expect(gateAllows("/chat/pyodide/pyodide.mjs", origin, prefix)).toBe(true);
		expect(gateAllows("/chat/pyodide/wheels/numpy-1.0.whl", origin, prefix)).toBe(true);
		// The un-prefixed dist path is a 404 in production — and must not
		// pass a base-aware gate either.
		expect(gateAllows("/pyodide/pyodide.mjs", origin, prefix)).toBe(false);
		expect(gateAllows("/chat/api/v2/user", origin, prefix)).toBe(false);
	});

	it("keeps PyPI blocked by default even for gateAllows' pypiEnabled param", () => {
		const origin = "https://chat.example.org";
		expect(gateAllows("https://pypi.org/simple/numpy/", origin)).toBe(false);
		expect(gateAllows("https://files.pythonhosted.org/packages/x.whl", origin)).toBe(false);
	});

	it("gateAllows opens exactly PyPI's two hosts when pypiEnabled is true", () => {
		const origin = "https://chat.example.org";
		expect(gateAllows("https://pypi.org/simple/numpy/", origin, undefined, true)).toBe(true);
		expect(
			gateAllows("https://files.pythonhosted.org/packages/x.whl", origin, undefined, true)
		).toBe(true);
		// Still nothing else, even with the escape hatch open.
		expect(gateAllows("https://evil.example/leak?d=secret", origin, undefined, true)).toBe(false);
		// http (not https) to a PyPI host stays blocked — the fetch itself
		// only ever proxies https for the escape hatch.
		expect(gateAllows("http://pypi.org/simple/numpy/", origin, undefined, true)).toBe(false);
	});

	it("installNetworkGate's controller opens PyPI only once enabled, credential-free", async () => {
		const inner = vi.fn((_input?: RequestInfo | URL, _init?: RequestInit) =>
			Promise.resolve(new Response("ok"))
		);
		const scope = {
			location: {
				href: "https://chat.example.org/_app/immutable/worker.js",
				origin: "https://chat.example.org",
			},
			fetch: inner,
			navigator: {},
		} as unknown as typeof globalThis;

		const controller = installNetworkGate(scope);

		// Off by default: PyPI is not reachable until opted in.
		await expect(scope.fetch("https://pypi.org/simple/numpy/")).rejects.toThrow(
			/execution sandbox/
		);
		expect(inner).not.toHaveBeenCalled();

		controller.setPyPiEnabled(true);
		await scope.fetch("https://pypi.org/simple/numpy/", { credentials: "include" });
		await scope.fetch("https://files.pythonhosted.org/packages/x.whl");
		expect(inner).toHaveBeenCalledTimes(2);
		// Whatever the caller asked for, credentials are forced off cross-origin.
		for (const call of inner.mock.calls) {
			expect((call[1] as RequestInit | undefined)?.credentials).toBe("omit");
		}

		// Turning it back off closes the hatch again.
		controller.setPyPiEnabled(false);
		await expect(scope.fetch("https://pypi.org/simple/numpy/")).rejects.toThrow(
			/execution sandbox/
		);
		expect(inner).toHaveBeenCalledTimes(2);
	});
});
