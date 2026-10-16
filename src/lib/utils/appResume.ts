/**
 * One place that knows "the app just came back": the tab became visible
 * again, the network returned, or the page was restored from the back-forward
 * cache. An open tab, and above all an installed PWA, sleeps through all
 * three with its timers throttled or frozen and its connections dropped; what
 * it holds (a sign-in, a stream, a machine list) can be stale by the time it
 * wakes, and nothing but a full reload used to put it right.
 *
 * Stores that hold such state register here and re-check when it fires.
 * Bursts coalesce (a phone fires `visibilitychange`, `pageshow` and `online`
 * within a moment of each other). The DOM listeners exist only while at least
 * one listener is registered.
 */
type Listener = () => void;

const MIN_GAP_MS = 3000;
const listeners = new Set<Listener>();
let installed = false;
let lastFired = 0;

function fire(): void {
	const now = Date.now();
	if (now - lastFired < MIN_GAP_MS) return;
	lastFired = now;
	for (const listener of [...listeners]) {
		try {
			listener();
		} catch {
			/* one listener's failure must not starve the others */
		}
	}
}

const onVisibility = () => {
	if (document.visibilityState === "visible") fire();
};
const onPageShow = (event: PageTransitionEvent) => {
	if (event.persisted) fire();
};

function install(): void {
	if (installed || typeof window === "undefined") return;
	installed = true;
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("online", fire);
	window.addEventListener("pageshow", onPageShow);
}

function uninstall(): void {
	if (!installed) return;
	installed = false;
	document.removeEventListener("visibilitychange", onVisibility);
	window.removeEventListener("online", fire);
	window.removeEventListener("pageshow", onPageShow);
}

/** Run `listener` whenever the app comes back. Returns the unsubscribe. */
export function onAppResume(listener: Listener): () => void {
	listeners.add(listener);
	install();
	return () => {
		listeners.delete(listener);
		if (listeners.size === 0) uninstall();
	};
}

/** Test seam: forget the throttle so each test starts clean. */
export function resetAppResume(): void {
	lastFired = 0;
}
