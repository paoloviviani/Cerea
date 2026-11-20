import { getContext, onDestroy, setContext } from "svelte";
import { delayedLoading } from "$lib/utils/delayedLoading.svelte";
import { createImageGroupMachine, IMAGE_GROUP_CAP_MS, type TileState } from "$lib/utils/imageGroup";

const KEY = Symbol("image-group");

/** The cap, 2 s. A spec may set `globalThis.__ceraeImageGroupCapMs` (an init script) for a slow runner; nothing in the app does. */
function capMs(): number {
	const set = (globalThis as { __ceraeImageGroupCapMs?: unknown }).__ceraeImageGroupCapMs;
	return typeof set === "number" && set > 0 ? set : IMAGE_GROUP_CAP_MS;
}

export interface ImageGroup {
	register(id: string): void;
	settle(id: string, ok: boolean): void;
	unregister(id: string): void;
	state(id: string): TileState | undefined;
	/** The placeholder of every tile is drawn (after the 150 ms grace, for at least 300 ms). */
	readonly shimmer: boolean;
	/** The group lets its loaded tiles show. */
	readonly revealed: boolean;
}

/** Call during component init: the tiles below it (`getImageGroup`) load and appear together. */
export function provideImageGroup(): ImageGroup {
	let version = $state(0);
	// Counted outside the state: `version += 1` would read it, and an effect that registers a tile
	// would then depend on the very thing it changes.
	let changes = 0;
	const machine = createImageGroupMachine(() => {
		version = ++changes;
	}, capMs());
	const delayed = delayedLoading(() => {
		void version;
		return machine.loading;
	});
	onDestroy(() => machine.destroy());
	const group: ImageGroup = {
		register: (id) => machine.register(id),
		settle: (id, ok) => machine.settle(id, ok),
		unregister: (id) => machine.unregister(id),
		state: (id) => {
			void version;
			return machine.state(id);
		},
		get shimmer() {
			return delayed.visible;
		},
		get revealed() {
			void version;
			return !machine.loading && !delayed.visible;
		},
	};
	setContext(KEY, group);
	return group;
}

export function getImageGroup(): ImageGroup | undefined {
	return getContext<ImageGroup | undefined>(KEY);
}
