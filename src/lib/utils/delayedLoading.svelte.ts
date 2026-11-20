import { onDestroy } from "svelte";
import { createDelayedLoadingMachine, type DelayedLoadingOptions } from "$lib/utils/delayedLoading";

export { SKELETON_DELAY_MS, SKELETON_MIN_MS } from "$lib/utils/delayedLoading";

/**
 * Reactive wrapper: `const d = delayedLoading(() => loading)`; render the placeholder while
 * `d.visible`, the content when `!d.visible && !loading`. Call during component init.
 */
export function delayedLoading(getLoading: () => boolean, options?: DelayedLoadingOptions) {
	let visible = $state(false);
	const machine = createDelayedLoadingMachine((v) => (visible = v), options);
	$effect.pre(() => {
		machine.set(getLoading());
	});
	onDestroy(() => machine.destroy());
	return {
		get visible() {
			return visible;
		},
	};
}
