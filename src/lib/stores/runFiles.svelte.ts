import type { MessageCodeExecutionOutputsUpdate } from "$lib/types/MessageUpdate";

/**
 * Output-file records made in this tab since the conversation loaded.
 *
 * The server keeps them (`codeRunFiles`) and the next load serves them on
 * their messages; this carries them in the meantime, so a code block's file
 * becomes a file artifact the moment its upload lands rather than on the next
 * reload. Merged into the messages the file-artifact registry reads, and
 * deduplicated there against what the server already served.
 */
class RunFilesStore {
	#byMessage = $state<Record<string, MessageCodeExecutionOutputsUpdate[]>>({});
	/** Runs this tab already persisted, by `runKey@startedAt`: a remount must not upload again. */
	#persisted = new Set<string>();

	add(messageId: string, update: MessageCodeExecutionOutputsUpdate): void {
		const list = this.#byMessage[messageId] ?? [];
		this.#byMessage[messageId] = [...list, update];
	}

	for(messageId: string): MessageCodeExecutionOutputsUpdate[] {
		return this.#byMessage[messageId] ?? [];
	}

	get all(): Record<string, MessageCodeExecutionOutputsUpdate[]> {
		return this.#byMessage;
	}

	/** True the first time a given run is claimed for persisting; false after. */
	claim(runId: string): boolean {
		if (this.#persisted.has(runId)) return false;
		this.#persisted.add(runId);
		return true;
	}

	/**
	 * Give up a claim that did not result in a record — a 409 (the message
	 * isn't saved under this id yet) or any other failure — so a later attempt
	 * (a retry, or the same run once its message carries the server's id) is
	 * not permanently blocked by the first, failed one.
	 */
	release(runId: string): void {
		this.#persisted.delete(runId);
	}
}

export const runFiles = new RunFilesStore();
