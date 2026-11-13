/**
 * How many notes the open chat holds, for the badge on the side panel's entry
 * button. The list itself lives in `ChatNotes.svelte`; this is only the number,
 * set when a chat opens, after each answer (the assistant may have written a
 * note) and by the list when the user adds or deletes one.
 */
class ChatNotesStore {
	count = $state(0);

	set(count: number) {
		this.count = Math.max(0, count);
	}
}

export const chatNotes = new ChatNotesStore();
