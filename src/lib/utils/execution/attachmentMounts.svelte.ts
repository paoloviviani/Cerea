import type { MessageFile } from "$lib/types/Message";
import { getExecutionSession } from "./runtime";
import { getMountsStore } from "./mounts.svelte";
import { AttachmentMounter } from "./attachmentMounter";

/**
 * Keeps the open chat conversation's attachments mounted in the sandbox.
 *
 * The sandbox is session-global — one interpreter shared by every chat block
 * and artifact — so this follows the conversation page: it is told which
 * conversation is open and what its messages hold, mounts the attachments
 * lazily just before a code run, and takes them out again when the person
 * moves to another conversation. Knowledge and artifact mounts are never
 * touched. Nothing is mounted until a run asks (`withAttachmentMounts`).
 *
 * Only the owner's chat page registers a source. A shared view, a read-only
 * view and the /code panel never do, so they never mount anything, and files
 * are only ever fetched through the open conversation's own id.
 */

interface Source {
	conversationId: string;
	files: MessageFile[];
}

class ConversationAttachments {
	#source: Source | undefined;
	#mounter: AttachmentMounter | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	/** Mounts queued or running; a run started meanwhile waits for them. */
	#pending = 0;
	#watching = false;

	/** The open chat conversation and its messages; `null` when there is none. */
	setSource(source: { conversationId: string; messages: Array<{ files?: MessageFile[] }> } | null) {
		if (this.#source && this.#source.conversationId !== source?.conversationId) this.reset();
		this.#source = source
			? {
					conversationId: source.conversationId,
					files: source.messages.flatMap((message) => message.files ?? []),
				}
			: undefined;
	}

	/** A pending mount, or `undefined` when there is nothing to do right now. */
	ensure(): Promise<void> | undefined {
		const source = this.#source;
		const session = getExecutionSession();
		if (!source || !session) return undefined;
		const mounter = this.mounterFor(source.conversationId, session);
		if (!mounter.needsSync(source.files)) {
			// Nothing new to mount, but an earlier run's mount may still be in
			// flight: starting now would run the code before its files are there.
			return this.#pending > 0 ? this.#queue.then(() => undefined) : undefined;
		}
		// Serialised: a run that starts while a mount is in flight waits for it
		// rather than racing a second fetch of the same file. `sync` does not
		// throw, but the catch keeps one that somehow did from leaving the queue
		// rejected — every later mount chained onto it would be skipped, silently.
		this.#pending += 1;
		const next = this.#queue
			.then(() => mounter.sync(source.files))
			.catch((err) => console.warn("[attachments] mounting failed:", err))
			.finally(() => {
				this.#pending -= 1;
			});
		this.#queue = next;
		return next;
	}

	private mounterFor(
		conversationId: string,
		session: NonNullable<ReturnType<typeof getExecutionSession>>
	): AttachmentMounter {
		if (!this.#watching) {
			this.#watching = true;
			// A reset sandbox (a timed-out run terminates the worker) comes back
			// empty: forget what was mounted so the next run mounts it again.
			session.onStatus((status) => {
				if (status !== "unloaded" || !this.#mounter) return;
				this.#mounter = undefined;
				getMountsStore()?.dropConversationFiles();
			});
		}
		this.#mounter ??= new AttachmentMounter(conversationId, session, {
			mounted: (file) => getMountsStore()?.recordConversationFile(file),
			skipped: (note) => getMountsStore()?.recordSkipped(note),
		});
		return this.#mounter;
	}

	private reset(): void {
		const mounter = this.#mounter;
		this.#mounter = undefined;
		getMountsStore()?.dropConversationFiles();
		if (mounter) this.#queue = this.#queue.then(() => mounter.unmountAll()).catch(() => undefined);
	}
}

let conversationAttachments: ConversationAttachments | undefined;

function store(): ConversationAttachments {
	conversationAttachments ??= new ConversationAttachments();
	return conversationAttachments;
}

/** Called by the chat page as its messages change; `null` on leaving it. */
export function setAttachmentSource(
	source: { conversationId: string; messages: Array<{ files?: MessageFile[] }> } | null
): void {
	if (typeof window === "undefined") return;
	store().setSource(source);
}

/**
 * Run `run` once the open conversation's attachments have settled in the
 * sandbox — mounted, or reported as not available on the chips. A mount that
 * fails never blocks the run, but the run does wait for it to finish failing:
 * code that starts while a file is still being fetched sees an empty
 * `/mnt/data`. When there is nothing pending `run` is called synchronously, as
 * it always was.
 */
export function withAttachmentMounts<T>(run: () => Promise<T>): Promise<T> {
	const pending = conversationAttachments?.ensure();
	return pending ? pending.then(run, run) : run();
}
