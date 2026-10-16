import { browser } from "$app/environment";

/**
 * Keep the app shell at the window's real height on mobile.
 *
 * The root shell is sized with dynamic viewport units (`100dvh`), which
 * Chrome on Android does not always recompute when a standalone PWA regains
 * its window after an out-of-scope round trip — the login through Authelia
 * opens a Custom Tab on top, and coming back can leave `dvh` stuck at the
 * taller in-tab value with no `resize` firing. The shell is `fixed` with
 * `overflow-hidden`, so the extra pixels push the composer below the fold
 * with no way to scroll it back, until the app is killed and reopened.
 *
 * Measuring `window.innerHeight` directly and re-measuring on every signal
 * that the window changed (including `pageshow`, which fires on the return
 * from the Custom Tab and on bfcache restores) keeps `--app-dvh` at the
 * height the window really has. The shell reads it with a `100dvh`
 * fallback, so desktop and pre-JS rendering are unchanged.
 */
export function initAppViewport(): () => void {
	if (!browser) return () => {};
	const root = document.documentElement;
	const apply = () => {
		root.style.setProperty("--app-dvh", `${window.innerHeight}px`);
	};
	apply();
	const onVisibility = () => {
		if (document.visibilityState === "visible") apply();
	};
	window.addEventListener("resize", apply);
	window.addEventListener("orientationchange", apply);
	window.addEventListener("pageshow", apply);
	document.addEventListener("visibilitychange", onVisibility);
	window.visualViewport?.addEventListener("resize", apply);
	return () => {
		window.removeEventListener("resize", apply);
		window.removeEventListener("orientationchange", apply);
		window.removeEventListener("pageshow", apply);
		document.removeEventListener("visibilitychange", onVisibility);
		window.visualViewport?.removeEventListener("resize", apply);
	};
}
