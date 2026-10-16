import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	appReload,
	isChunkLoadError,
	reloadApp,
	reloadForChunkError,
	watchChunkErrors,
} from "./appReload";

describe("appReload", () => {
	beforeEach(() => {
		window.sessionStorage.clear();
		vi.restoreAllMocks();
	});

	it("reloadApp reloads the current page", () => {
		const spy = vi.spyOn(appReload, "reload").mockImplementation(() => {});
		reloadApp();
		expect(spy).toHaveBeenCalledTimes(1);
	});

	it("recognises the chunk-load failures of each engine", () => {
		expect(
			isChunkLoadError(new TypeError("Failed to fetch dynamically imported module: /a.js"))
		).toBe(true);
		expect(isChunkLoadError(new TypeError("error loading dynamically imported module"))).toBe(true);
		expect(isChunkLoadError(new TypeError("Importing a module script failed."))).toBe(true);
		expect(isChunkLoadError(new Error("something else"))).toBe(false);
	});

	it("reloads the current URL once, then not again within the minute (no loop)", () => {
		const spy = vi.spyOn(appReload, "navigate").mockImplementation(() => {});
		expect(reloadForChunkError(1_000_000)).toBe(true);
		expect(reloadForChunkError(1_030_000)).toBe(false);
		expect(reloadForChunkError(1_070_000)).toBe(true);
		expect(spy).toHaveBeenCalledTimes(2);
		expect(spy).toHaveBeenCalledWith(window.location.href);
	});

	it("reloads on vite:preloadError", () => {
		const spy = vi.spyOn(appReload, "navigate").mockImplementation(() => {});
		const stop = watchChunkErrors();
		window.dispatchEvent(new Event("vite:preloadError", { cancelable: true }));
		expect(spy).toHaveBeenCalledTimes(1);
		stop();
	});
});
