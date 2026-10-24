import { CHAT_DRAG_TYPE } from "$lib/stores/chatDrag.svelte";

/**
 * Whether files are being dragged over the window — the cue for a composer
 * to swap its input for `FileDropzone`. `dragleave` fires for every child
 * the pointer crosses, so only a leave from the element the drag last
 * entered ends it.
 *
 * Wire `enter`/`leave` to `<svelte:window ondragenter ondragleave>`, and
 * `bind:onDrag={drag.active}` on the dropzone so a drop ends it too.
 */
export class FileDrag {
	active = $state(false);
	#lastTarget: EventTarget | null = null;

	enter = (e: DragEvent) => {
		// A sidebar chat being moved to a project is not a file.
		if (e.dataTransfer?.types.includes(CHAT_DRAG_TYPE)) return;
		this.#lastTarget = e.target;
		this.active = true;
	};

	leave = (e: DragEvent) => {
		if (e.target === this.#lastTarget) {
			this.active = false;
		}
	};
}
