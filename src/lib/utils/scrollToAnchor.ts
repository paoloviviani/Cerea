/**
 * Scroll an in-page anchor into view inside its own scroll pane only.
 *
 * The app shell is `fixed h-dvh overflow-hidden`, and the browser's native
 * hash scroll (and `scrollIntoView`) also scrolls such overflow-hidden
 * ancestors: the whole shell slid up, leaving most of the screen blank with
 * no way to scroll back. This scrolls the nearest scrollable pane instead and
 * resets any overflow-hidden ancestor the browser already shifted.
 */
export function scrollToAnchor(id: string, offset = 16): boolean {
	const el = document.getElementById(id);
	if (!el) return false;
	let pane: HTMLElement | null = null;
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflowY = getComputedStyle(node).overflowY;
		if (!pane && (overflowY === "auto" || overflowY === "scroll")) {
			pane = node;
		} else if (pane && node.scrollTop !== 0) {
			node.scrollTop = 0;
		}
	}
	document.scrollingElement?.scrollTo?.(0, 0);
	if (pane) {
		pane.scrollTop += el.getBoundingClientRect().top - pane.getBoundingClientRect().top - offset;
	}
	return true;
}
