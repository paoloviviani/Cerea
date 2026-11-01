import { describe, expect, it, vi } from "vitest";
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

	// Chromium owns visualViewport on Window.prototype; an own property shadows
	// the accessor, so a stub can stand in for the browsers the meta key does
	// not reach. Deleting the own property restores the real one.
	type VisualViewportStub = EventTarget & { height: number; offsetTop: number };

	function stubVisualViewport(initial: { height: number; offsetTop: number }): {
		target: VisualViewportStub;
		set: (next: { height?: number; offsetTop?: number }) => void;
	} {
		const target = new EventTarget() as VisualViewportStub;
		let height = initial.height;
		let offsetTop = initial.offsetTop;
		Object.defineProperty(target, "height", { get: () => height, configurable: true });
		Object.defineProperty(target, "offsetTop", { get: () => offsetTop, configurable: true });
		return {
			target,
			set: (next) => {
				if (next.height !== undefined) height = next.height;
				if (next.offsetTop !== undefined) offsetTop = next.offsetTop;
			},
		};
	}

	const installStub = (stub: EventTarget) => {
		Object.defineProperty(window, "visualViewport", {
			value: stub,
			configurable: true,
			writable: true,
		});
	};
	const uninstallStub = () => {
		delete (window as { visualViewport?: unknown }).visualViewport;
	};

	it("follows the visual viewport's height where the keyboard shrinks only that", () => {
		const stub = stubVisualViewport({ height: 500, offsetTop: 0 });
		installStub(stub.target);
		const cleanup = initAppViewport();
		try {
			expect(document.documentElement.style.getPropertyValue("--app-dvh")).toBe("500px");
			// The keyboard opens: only the visual viewport shrinks.
			stub.set({ height: 320 });
			stub.target.dispatchEvent(new Event("resize"));
			expect(document.documentElement.style.getPropertyValue("--app-dvh")).toBe("320px");
		} finally {
			cleanup();
			uninstallStub();
			document.documentElement.style.removeProperty("--app-dvh");
		}
	});

	it("falls back to innerHeight without a visual viewport", () => {
		installStub(undefined as unknown as EventTarget);
		const cleanup = initAppViewport();
		try {
			expect(document.documentElement.style.getPropertyValue("--app-dvh")).toBe(
				`${window.innerHeight}px`
			);
		} finally {
			cleanup();
			uninstallStub();
			document.documentElement.style.removeProperty("--app-dvh");
		}
	});

	it("scrolls the keyboard's pan back while a field is focused", () => {
		const stub = stubVisualViewport({ height: 500, offsetTop: 0 });
		installStub(stub.target);
		const shell = document.createElement("div");
		shell.id = "app";
		const field = document.createElement("textarea");
		shell.appendChild(field);
		document.body.appendChild(shell);
		const scrollTo = vi.spyOn(window, "scrollTo");
		const cleanup = initAppViewport();
		try {
			// A pan with nothing focused is a zoom gesture: left alone.
			stub.set({ offsetTop: 150 });
			stub.target.dispatchEvent(new Event("scroll"));
			expect(scrollTo).not.toHaveBeenCalled();

			// The same pan with the composer focused is the keyboard: undo it.
			field.focus();
			stub.target.dispatchEvent(new Event("scroll"));
			expect(scrollTo).toHaveBeenCalledWith(0, 0);

			// The resize that reports the keyboard counters a pan that beat it.
			scrollTo.mockClear();
			stub.target.dispatchEvent(new Event("resize"));
			expect(scrollTo).toHaveBeenCalledWith(0, 0);

			// Back at the top there is nothing to undo.
			scrollTo.mockClear();
			stub.set({ offsetTop: 0 });
			stub.target.dispatchEvent(new Event("scroll"));
			expect(scrollTo).not.toHaveBeenCalled();
		} finally {
			cleanup();
			scrollTo.mockRestore();
			uninstallStub();
			shell.remove();
			document.documentElement.style.removeProperty("--app-dvh");
		}
	});
});
