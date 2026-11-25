/**
 * An interval that only runs while the tab is visible.
 *
 * A hidden tab asks nothing: the timer is cleared on `visibilitychange` to
 * hidden, and when the tab is shown again `fn` runs once at once (the data
 * may be stale by then) and the interval restarts. That keeps idle laptops
 * and the desktop app asleep: a plain `setInterval` keeps waking the CPU (and
 * the network radio) in a background tab, even throttled to once a minute.
 *
 * Returns the stop function; call it from the component cleanup.
 */
export function visibleInterval(
	fn: () => void,
	ms: number,
	options: { immediateOnVisible?: boolean } = {}
): () => void {
	const { immediateOnVisible = true } = options;
	if (typeof document === "undefined") return () => undefined;

	let timer: ReturnType<typeof setInterval> | null = null;
	const start = () => {
		if (timer === null) timer = setInterval(fn, ms);
	};
	const stop = () => {
		if (timer !== null) clearInterval(timer);
		timer = null;
	};
	const onVisibility = () => {
		if (document.hidden) {
			stop();
		} else if (timer === null) {
			if (immediateOnVisible) fn();
			start();
		}
	};

	document.addEventListener("visibilitychange", onVisibility);
	if (!document.hidden) start();
	return () => {
		document.removeEventListener("visibilitychange", onVisibility);
		stop();
	};
}
