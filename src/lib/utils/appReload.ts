/**
 * Reloading the app: the one thing an installed PWA cannot do for itself (it
 * has no address bar and no pull-to-refresh), and what picks up a new
 * version after a deploy.
 */

/** Test seam: the side effects, replaceable (`location.reload` cannot be
 * spied on in a browser test). */
export const appReload = {
	reload(): void {
		window.location.reload();
	},
	navigate(url: string): void {
		window.location.href = url;
	},
};

/** Reload the current page from the server. */
export function reloadApp(): void {
	appReload.reload();
}

const CHUNK_RELOAD_KEY = "app-chunk-reload-at";
const CHUNK_RELOAD_GUARD_MS = 60_000;

/** A lazily imported chunk that 404s or fails to parse after a deploy.
 * Matches the messages Chromium, Firefox and Safari give. */
export function isChunkLoadError(reason: unknown): boolean {
	const message = reason instanceof Error ? reason.message : String(reason ?? "");
	return /dynamically imported module|importing a module script failed|error loading dynamically imported module|failed to fetch dynamically/i.test(
		message
	);
}

/** Reload the current URL after a chunk failed to load: the old client is
 * asking for files a new deploy removed. Once per minute at most, so a chunk
 * that is really missing cannot put the page in a reload loop. Returns
 * whether it reloaded. */
export function reloadForChunkError(now: number = Date.now()): boolean {
	let last = 0;
	try {
		last = Number(window.sessionStorage.getItem(CHUNK_RELOAD_KEY) ?? 0);
		if (now - last < CHUNK_RELOAD_GUARD_MS) return false;
		window.sessionStorage.setItem(CHUNK_RELOAD_KEY, String(now));
	} catch {
		return false;
	}
	appReload.navigate(window.location.href);
	return true;
}

/** Install the page-wide chunk-failure handlers. Returns the cleanup. */
export function watchChunkErrors(): () => void {
	const onPreload = (event: Event) => {
		event.preventDefault();
		reloadForChunkError();
	};
	const onRejection = (event: PromiseRejectionEvent) => {
		if (isChunkLoadError(event.reason)) reloadForChunkError();
	};
	window.addEventListener("vite:preloadError", onPreload);
	window.addEventListener("unhandledrejection", onRejection);
	return () => {
		window.removeEventListener("vite:preloadError", onPreload);
		window.removeEventListener("unhandledrejection", onRejection);
	};
}
