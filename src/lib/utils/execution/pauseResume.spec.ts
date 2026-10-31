import { describe, expect, it, vi } from "vitest";
import { createWakeLock } from "./pauseResume";

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
