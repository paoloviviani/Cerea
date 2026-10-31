import { describe, expect, it, vi } from "vitest";
import { createWakeLock, reportPaused } from "./pauseResume";

const sentinel = () => ({ release: vi.fn(async () => undefined), addEventListener: vi.fn() });

describe("createWakeLock", () => {
	it("requests a screen lock once and releases it", async () => {
		const s = sentinel();
		const request = vi.fn(async () => s);
		const lock = createWakeLock({ wakeLock: { request } });
		await lock.acquire();
		await lock.acquire();
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith("screen");
		lock.release();
		lock.release();
		expect(s.release).toHaveBeenCalledTimes(1);
	});

	it("never throws when unsupported or denied", async () => {
		await expect(createWakeLock({}).acquire()).resolves.toBeUndefined();
		await expect(createWakeLock(undefined).acquire()).resolves.toBeUndefined();
		const denied = createWakeLock({
			wakeLock: {
				request: async () => {
					throw new Error("NotAllowedError");
				},
			},
		});
		await expect(denied.acquire()).resolves.toBeUndefined();
		expect(() => denied.release()).not.toThrow();
	});

	it("releases a lock that arrives after the run already ended", async () => {
		const s = sentinel();
		let grant: (v: ReturnType<typeof sentinel>) => void = () => undefined;
		const lock = createWakeLock({ wakeLock: { request: () => new Promise((r) => (grant = r)) } });
		const pending = lock.acquire();
		lock.release();
		grant(s);
		await pending;
		expect(s.release).toHaveBeenCalledTimes(1);
	});
});

describe("reportPaused", () => {
	it("falls back to a keepalive fetch when sendBeacon throws", () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("navigator", {
			sendBeacon: () => {
				throw new TypeError("blob type not allowed");
			},
		});
		expect(() => reportPaused("c1", "e1")).not.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toContain("/conversation/c1/code-execution/paused");
		vi.unstubAllGlobals();
	});

	it("uses only the beacon when it accepts the payload, and fetch when it refuses", () => {
		const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("{}"));
		vi.stubGlobal("fetch", fetchMock);
		vi.stubGlobal("navigator", { sendBeacon: () => true });
		reportPaused("c1", "e1");
		expect(fetchMock).not.toHaveBeenCalled();
		vi.stubGlobal("navigator", { sendBeacon: () => false });
		reportPaused("c1", "e1");
		expect(fetchMock).toHaveBeenCalledTimes(1);
		vi.unstubAllGlobals();
	});
});
