import { untrack } from "svelte";
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
	/**
	 * What runs in this tab produced, from the instant their files are listed
	 * and fingerprinted — before any upload or server record. Keyed by
	 * message, then run, one entry per run (a later call for the same run
	 * replaces it, e.g. once the upload answers). This is what puts a file in
	 * the registry the moment it exists.
	 */
	#live = $state<Record<string, Record<string, MessageCodeExecutionOutputsUpdate>>>({});
	/** Runs this tab already persisted, by `runKey@startedAt`: a remount must not upload again. */
	#persisted = new Set<string>();

	add(messageId: string, update: MessageCodeExecutionOutputsUpdate): void {
		const list = this.#byMessage[messageId] ?? [];
		this.#byMessage[messageId] = [...list, update];
	}

	/** Record (or replace) the live entry of one run on a message. */
	setLive(messageId: string, update: MessageCodeExecutionOutputsUpdate): void {
		// Untracked read: callers are effects, and an effect that reads what it
		// writes would run again for ever.
		const runs = untrack(() => this.#live[messageId] ?? {});
		const current = runs[update.runKey];
		if (current) {
			if (JSON.stringify(current.files) === JSON.stringify(update.files)) return;
			// An in-flight listing never overwrites what an upload already answered.
			const sameFiles =
				current.files.length === update.files.length &&
				current.files.every(
					(f, i) => f.sha256 === update.files[i].sha256 && f.name === update.files[i].name
				);
			if (sameFiles && update.files.every((f) => f.uploaded === undefined)) return;
		}
		this.#live[messageId] = { ...runs, [update.runKey]: update };
	}

	for(messageId: string): MessageCodeExecutionOutputsUpdate[] {
		return this.#byMessage[messageId] ?? [];
	}

	/**
	 * Per message: the records the server confirmed, then the live entries.
	 * The registry skips a live entry the server's records already cover.
	 */
	get all(): Record<string, MessageCodeExecutionOutputsUpdate[]> {
		const merged: Record<string, MessageCodeExecutionOutputsUpdate[]> = {};
		for (const [id, list] of Object.entries(this.#byMessage)) merged[id] = [...list];
		for (const [id, runs] of Object.entries(this.#live)) {
			merged[id] = [...(merged[id] ?? []), ...Object.values(runs)];
		}
		return merged;
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
