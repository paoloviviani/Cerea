import { describe, expect, it } from "vitest";
import { initAppViewport } from "./appViewport";

// Exercises the real window/document (client project runs in Chromium), the
// same surface the Android standalone PWA measures after the login Custom
// Tab closes.
describe("initAppViewport", () => {
	it("pins --app-dvh to the window's real height", () => {
		const cleanup = initAppViewport();
		try {
			expect(document.documentElement.style.getPropertyValue("--app-dvh")).toBe(
				`${window.innerHeight}px`
			);
		} finally {
			cleanup();
			document.documentElement.style.removeProperty("--app-dvh");
		}
	});

	it("re-measures on pageshow, the signal for returning from the login tab", () => {
		const cleanup = initAppViewport();
		try {
			// A stale tall value, as left behind by the in-tab viewport.
			document.documentElement.style.setProperty("--app-dvh", "9999px");
			window.dispatchEvent(new Event("pageshow"));
			expect(document.documentElement.style.getPropertyValue("--app-dvh")).toBe(
				`${window.innerHeight}px`
			);
		} finally {
			cleanup();
			document.documentElement.style.removeProperty("--app-dvh");
		}
	});

	it("stops measuring after cleanup", () => {
		const cleanup = initAppViewport();
		cleanup();
		document.documentElement.style.setProperty("--app-dvh", "9999px");
		try {
			window.dispatchEvent(new Event("resize"));
			expect(document.documentElement.style.getPropertyValue("--app-dvh")).toBe("9999px");
		} finally {
			document.documentElement.style.removeProperty("--app-dvh");
		}
	});
});
