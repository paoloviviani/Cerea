/**
 * The tiles of one message's pictures load together: none shows until every one has settled (loaded or
 * failed), or until `capMs` has passed since the first began, whichever is first. Then they fade in as one,
 * so a row of photos does not pop in one after another.
 *
 * The machine has no framework in it: `onChange` is called after every change, and `loading` says whether
 * the group is still holding its tiles back (it is what `delayedLoading` turns into a placeholder that
 * never flashes).
 */
export const IMAGE_GROUP_CAP_MS = 2000;

export type TileState = "pending" | "loaded" | "failed";

export interface ImageGroupMachine {
	register(id: string): void;
	settle(id: string, ok: boolean): void;
	unregister(id: string): void;
	state(id: string): TileState | undefined;
	/** Held back: some tile is still loading and the cap has not passed. */
	readonly loading: boolean;
	destroy(): void;
}

export function createImageGroupMachine(
	onChange: () => void,
	capMs: number = IMAGE_GROUP_CAP_MS
): ImageGroupMachine {
	const tiles = new Map<string, TileState>();
	let capped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const settled = () => [...tiles.values()].every((s) => s !== "pending");
	const clear = () => {
		if (timer !== undefined) clearTimeout(timer);
		timer = undefined;
	};

	return {
		register(id) {
			if (tiles.has(id)) return;
			tiles.set(id, "pending");
			// The cap runs from the first tile, so a late one cannot hold the others back for ever.
			if (timer === undefined && !capped) {
				timer = setTimeout(() => {
					timer = undefined;
					capped = true;
					onChange();
				}, capMs);
			}
			onChange();
		},
		settle(id, ok) {
			if (!tiles.has(id)) return;
			tiles.set(id, ok ? "loaded" : "failed");
			if (settled()) clear();
			onChange();
		},
		unregister(id) {
			if (tiles.delete(id)) {
				if (tiles.size === 0) clear();
				onChange();
			}
		},
		state: (id) => tiles.get(id),
		get loading() {
			return tiles.size > 0 && !capped && !settled();
		},
		destroy: clear,
	};
}
