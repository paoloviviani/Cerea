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
 * The keyboard is the second case. The viewport meta carries
 * `interactive-widget=resizes-content` (Chrome 108+), so the layout viewport
 * shrinks when the keyboard opens and `innerHeight` follows it. Where that
 * key is ignored — iOS Safari, older Chrome — the layout viewport keeps its
 * height and only the visual viewport shrinks, so `--app-dvh` is measured
 * from `visualViewport.height` when there is one. Those modes also *pan* the
 * page under the keyboard to reveal the focused field: the fixed shell slides
 * up with the pan and the top bar leaves the screen. While a field is
 * focused, any such pan (`visualViewport.offsetTop > 0`) is scrolled straight
 * back — the shell is already sized to the visible height, so the composer
 * needs no revealing, and the shell stays pinned to the top.
 *
 * Measuring directly and re-measuring on every signal that the window
 * changed (including `pageshow`, which fires on the return from the Custom
 * Tab and on bfcache restores) keeps `--app-dvh` at the height the window
 * really has. The shell reads it with a `100dvh` fallback, so desktop and
 * pre-JS rendering are unchanged.
 */
export function initAppViewport(): () => void {
	if (!browser) return () => {};
	const root = document.documentElement;
	const visual = window.visualViewport;
	const apply = () => {
		// The visual viewport shrinks with the keyboard where the layout
		// viewport does not; at scale 1 the two agree. Zoomed in (iOS allows
		// it whatever the meta says) it shrinks with the zoom instead, which
		// is not a smaller window: keep the layout height then.
		const height = visual && visual.scale === 1 ? visual.height : window.innerHeight;
		root.style.setProperty("--app-dvh", `${Math.round(height)}px`);
	};
	const unpan = () => {
		if (!visual || visual.offsetTop <= 0 || visual.scale !== 1) return;
		// A field focused is the keyboard's own doing (the app's dialogs portal
		// beside the shell, so any focused field in the document counts); a pan
		// with nothing focused — or while zoomed in, which iOS allows whatever
		// the meta says — is the user's own gesture and is left alone.
		const active = document.activeElement;
		const isField =
			active instanceof HTMLInputElement ||
			active instanceof HTMLTextAreaElement ||
			(active instanceof HTMLElement && active.isContentEditable);
		if (!isField) return;
		window.scrollTo(0, 0);
	};
	const onViewportResize = () => {
		apply();
		unpan();
	};
	apply();
	const onVisibility = () => {
		if (document.visibilityState === "visible") apply();
	};
	window.addEventListener("resize", apply);
	window.addEventListener("orientationchange", apply);
	window.addEventListener("pageshow", apply);
	document.addEventListener("visibilitychange", onVisibility);
	if (visual) {
		visual.addEventListener("resize", onViewportResize);
		visual.addEventListener("scroll", unpan);
	}
	return () => {
		window.removeEventListener("resize", apply);
		window.removeEventListener("orientationchange", apply);
		window.removeEventListener("pageshow", apply);
		document.removeEventListener("visibilitychange", onVisibility);
		if (visual) {
			visual.removeEventListener("resize", onViewportResize);
			visual.removeEventListener("scroll", unpan);
		}
	};
}
