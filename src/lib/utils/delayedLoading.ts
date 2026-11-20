/**
 * Anti-flicker timing for loading placeholders, shared by every skeleton in the app.
 *
 * A load that finishes in under `delayMs` never shows a placeholder (the region stays as it was,
 * then the content arrives in one step); a placeholder that did appear stays up for at least
 * `minMs`, so it is never a flash. `visible` is the only thing a region needs to render:
 * placeholder while `visible`, content once `!visible && !loading`.
 */
export const SKELETON_DELAY_MS = 150;
export const SKELETON_MIN_MS = 300;

export interface DelayedLoadingOptions {
	delayMs?: number;
	minMs?: number;
}

export interface DelayedLoadingMachine {
	/** Report the current loading state (idempotent). */
	set(loading: boolean): void;
	/** Cancel pending timers. */
	destroy(): void;
}

/** The timer logic with no framework: `onChange` is called with every change of visibility. */
export function createDelayedLoadingMachine(
	onChange: (visible: boolean) => void,
	{ delayMs = SKELETON_DELAY_MS, minMs = SKELETON_MIN_MS }: DelayedLoadingOptions = {}
): DelayedLoadingMachine {
	let loading = false;
	let visible = false;
	let shownAt = 0;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const setVisible = (next: boolean) => {
		if (visible === next) return;
		visible = next;
		onChange(next);
	};
	const clear = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};

	return {
		set(next) {
			if (next === loading) return;
			loading = next;
			clear();
			if (next) {
				// Already showing (loading restarted during the minimum): just stay.
				if (visible) return;
				timer = setTimeout(() => {
					timer = undefined;
					shownAt = Date.now();
					setVisible(true);
				}, delayMs);
			} else if (visible) {
				const remaining = Math.max(0, shownAt + minMs - Date.now());
				timer = setTimeout(() => {
					timer = undefined;
					setVisible(false);
				}, remaining);
			}
		},
		destroy: clear,
	};
}
