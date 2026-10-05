/**
 * Run `fn` at most once per `ms`, and never lose the last call: one that lands
 * inside the window is held and runs when the window ends. A plain leading
 * throttle drops it, which is how a "the child finished" signal arriving a
 * moment after the previous poll left a status banner on screen for good.
 */
export function throttleTrailing(fn: () => void, ms: number) {
	let last = -Infinity;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const run = () => {
		timer = undefined;
		last = Date.now();
		fn();
	};
	return {
		call() {
			if (timer !== undefined) return;
			const wait = last + ms - Date.now();
			if (wait <= 0) run();
			else timer = setTimeout(run, wait);
		},
		cancel() {
			if (timer !== undefined) clearTimeout(timer);
			timer = undefined;
		},
	};
}
