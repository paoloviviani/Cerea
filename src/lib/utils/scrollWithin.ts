/**
 * Scroll `target` to the top of its own scrolling column, and nothing else.
 *
 * `Element.scrollIntoView` scrolls every scrollable ancestor to make the target
 * visible, and the app's root is `fixed h-dvh overflow-hidden`: hidden is still
 * scrollable by script, so a link inside a page's own column shifted the whole
 * window (sidebar cut off, page header gone). This moves only the nearest
 * ancestor that really scrolls.
 *
 * `offset` is the space to leave above the target, for a bar that sticks to the
 * top of the column.
 */
export function scrollWithin(
	target: HTMLElement,
	opts: { offset?: number; behavior?: ScrollBehavior } = {}
): boolean {
	const container = scrollParent(target);
	if (!container) return false;
	const top =
		target.getBoundingClientRect().top -
		container.getBoundingClientRect().top +
		container.scrollTop -
		(opts.offset ?? 0);
	container.scrollTo({ top: Math.max(0, top), behavior: opts.behavior ?? "auto" });
	return true;
}

/** The nearest ancestor whose content actually overflows and scrolls vertically. */
export function scrollParent(el: HTMLElement): HTMLElement | null {
	for (let node = el.parentElement; node; node = node.parentElement) {
		const overflowY = getComputedStyle(node).overflowY;
		if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) {
			return node;
		}
	}
	return null;
}
