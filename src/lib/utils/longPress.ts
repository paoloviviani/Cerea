/**
 * A touch long-press, as a Svelte action: holding a finger (or pen) on the
 * node for `LONG_PRESS_MS` without moving calls `onpress`. A mouse never
 * triggers it: a pointer that can hover has the row's own buttons.
 *
 * The click that follows the lift is swallowed once, so the press that opened
 * a row's menu does not also follow the row's link; and the browser's own
 * context menu (Android shows one on a held link) is suppressed while a press
 * is in flight or has just fired.
 */
export const LONG_PRESS_MS = 500;
const MOVE_TOLERANCE_PX = 10;

export function longPress(node: HTMLElement, onpress: () => void) {
	let handler = onpress;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let startX = 0;
	let startY = 0;
	let fired = false;
	let pending = false;

	const cancel = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
		pending = false;
	};
	const swallowClick = () => {
		const stop = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
		};
		node.addEventListener("click", stop, { capture: true, once: true });
		setTimeout(() => node.removeEventListener("click", stop, { capture: true }), 600);
	};
	const down = (event: PointerEvent) => {
		if (event.pointerType === "mouse") return;
		startX = event.clientX;
		startY = event.clientY;
		fired = false;
		cancel();
		pending = true;
		timer = setTimeout(() => {
			timer = undefined;
			fired = true;
			swallowClick();
			handler();
		}, LONG_PRESS_MS);
	};
	const move = (event: PointerEvent) => {
		if (timer === undefined) return;
		if (Math.hypot(event.clientX - startX, event.clientY - startY) > MOVE_TOLERANCE_PX) cancel();
	};
	const contextmenu = (event: Event) => {
		if (pending || fired) event.preventDefault();
	};
	const up = () => {
		cancel();
		// `fired` stays set until the next press: the contextmenu event can
		// arrive after the lift.
	};

	node.addEventListener("pointerdown", down);
	node.addEventListener("pointermove", move);
	node.addEventListener("pointerup", up);
	node.addEventListener("pointercancel", up);
	node.addEventListener("contextmenu", contextmenu);
	return {
		update(next: () => void) {
			handler = next;
		},
		destroy() {
			cancel();
			node.removeEventListener("pointerdown", down);
			node.removeEventListener("pointermove", move);
			node.removeEventListener("pointerup", up);
			node.removeEventListener("pointercancel", up);
			node.removeEventListener("contextmenu", contextmenu);
		},
	};
}
