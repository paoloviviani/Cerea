/**
 * The sidebar chat being dragged, if any.
 *
 * A drop target cannot read the drag's data while the pointer is still over it
 * (browsers only expose the data type list until the drop), so which chat is
 * in flight, and where it lives now, is kept here. Client-only: set on
 * `dragstart`, cleared on `dragend` or after the drop.
 */

export const CHAT_DRAG_TYPE = "application/x-cerea-conversation";

export interface DraggedChat {
	id: string;
	title: string;
	model?: string;
	/** The project it is in, if any. */
	projectId?: string;
}

export const chatDrag = $state<{ current: DraggedChat | null }>({ current: null });
