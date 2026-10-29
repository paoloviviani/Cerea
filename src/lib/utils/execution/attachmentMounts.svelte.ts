import { onDestroy } from "svelte";
import { base } from "$app/paths";
import type { MessageFile } from "$lib/types/Message";
import { getExecutionSession } from "./runtime";
import { getMountsStore } from "./mounts.svelte";
import { AttachmentMounter, type ProducedFile } from "./attachmentMounter";

/**
 * Keeps the open chat conversation's files mounted in the sandbox: its
 * attachments, and the files its tools and runs produced (the latest version
 * of each name, listed from the server on every run, because a document tool
 * can save a new version between two runs).
 *
 * The sandbox is session-global — one interpreter shared by every chat block
 * and artifact — so this follows the conversation page: it is told which
 * conversation is open and what its messages hold, mounts the attachments
 * lazily just before a code run, and takes them out again when the person
 * moves to another conversation. Knowledge and artifact mounts are never
 * touched. Nothing is mounted until a run asks (`withAttachmentMounts`).
 *
 * A sandbox restart (a run stopped by the time limit, a crash) needs nothing
 * from here: the session keeps every mounted file and writes them all back
 * into the new worker before its first request, under the same names, so the
 * mounter's record of what is mounted stays true and the chips stay.
 *
 * Only the owner's chat page registers a source. A shared view, a read-only
 * view and the /code panel never do, so they never mount anything, and files
 * are only ever fetched through the open conversation's own id.
 */

/** What the chat page tells this about a message: the ones of the open branch, in order. */
export interface SourceMessage {
	id?: string;
	files?: MessageFile[];
	createdAt?: Date | string;
}

interface Source {
	conversationId: string;
	files: Array<MessageFile & { sentAt?: number }>;
	/**
	 * The last messages of the branch on screen, newest first: the files listed for it are that
	 * branch's. The newest may not be saved yet (a client-minted id); the one before then names it.
	 */
	leafIds: string[];
}

function sentAtOf(message: SourceMessage): number | undefined {
	if (!message.createdAt) return undefined;
	const at = new Date(message.createdAt).getTime();
	return Number.isFinite(at) ? at : undefined;
}

class ConversationAttachments {
	#source: Source | undefined;
	#mounter: AttachmentMounter | undefined;
	#queue: Promise<unknown> = Promise.resolve();
	/** Mounts queued or running; a run started meanwhile waits for them. */
	#pending = 0;

	/** The open chat conversation and its messages; `null` when there is none. */
	setSource(source: { conversationId: string; messages: SourceMessage[] } | null) {
		if (this.#source && this.#source.conversationId !== source?.conversationId) this.reset();
		this.#source = source
			? {
					conversationId: source.conversationId,
					files: source.messages.flatMap((message) => {
						const sentAt = sentAtOf(message);
						return (message.files ?? []).map((file) =>
							sentAt === undefined ? file : { ...file, sentAt }
						);
					}),
					leafIds: source.messages
						.slice(-2)
						.reverse()
						.flatMap((message) => (message.id ? [message.id] : [])),
				}
			: undefined;
	}

	/** The pending mount of the open conversation's files; `undefined` when none is open. */
	ensure(code?: string): Promise<void> | undefined {
		const source = this.#source;
		const session = getExecutionSession();
		if (!source || !session) return undefined;
		const mounter = this.mounterFor(source.conversationId, session);
		// Serialised: a run that starts while a mount is in flight waits for it
		// rather than racing a second fetch of the same file. Neither step
		// throws, but the catch keeps one that somehow did from leaving the queue
		// rejected — every later mount chained onto it would be skipped, silently.
		this.#pending += 1;
		const next = this.#queue
			.then(async () => {
				if (mounter.needsSync(source.files)) await mounter.sync(source.files);
				const listed = await listProduced(source.conversationId, source.leafIds);
				if (listed) await mounter.syncProduced(listed, { code });
			})
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

/** How long a run waits for the list of the conversation's stored files. */
export const LIST_TIMEOUT_MS = 5000;

/**
 * The conversation's stored files as the open branch sees them (`leaf` names its last
 * messages); `undefined` when the list cannot be had (the run still goes ahead, and what is
 * mounted stays as it is).
 */
async function listProduced(
	conversationId: string,
	leafIds: readonly string[] = []
): Promise<ProducedFile[] | undefined> {
	try {
		const query = leafIds.length
			? `?${leafIds.map((id) => `leaf=${encodeURIComponent(id)}`).join("&")}`
			: "";
		// Every run waits on this: a slow answer must not hold the code back.
		const response = await fetch(
			`${base}/conversation/${conversationId}/code-execution/output${query}`,
			{ credentials: "same-origin", signal: AbortSignal.timeout(LIST_TIMEOUT_MS) }
		);
		if (!response.ok) return undefined;
		const body = (await response.json()) as { files?: ProducedFile[] };
		return Array.isArray(body.files) ? body.files : [];
	} catch (err) {
		console.warn("[attachments] the conversation's produced files were not listed:", err);
		return undefined;
	}
}

let conversationAttachments: ConversationAttachments | undefined;

function store(): ConversationAttachments {
	conversationAttachments ??= new ConversationAttachments();
	return conversationAttachments;
}

/** Called by the chat page as its messages change; `null` on leaving it. */
export function setAttachmentSource(
	source: { conversationId: string; messages: SourceMessage[] } | null
): void {
	if (typeof window === "undefined") return;
	store().setSource(source);
}

/**
 * Follow the open conversation from a component's script (the chat page):
 * `read` gives the conversation and its messages, or `null` when there is
 * none, and the source is dropped when the component is destroyed.
 *
 * It must be `$effect.pre`, not `$effect`. Effects run children first, and a
 * code card that is on screen when the page mounts (a reload or a reopened tab
 * while the turn waits on `execute_code`) starts its run in its own effect: a
 * plain `$effect` here registered the conversation only after that run had
 * started, so the first run found nothing mounted and `/mnt/data` was empty.
 * A pre effect runs while the page is being created, before any child exists.
 */
export function trackAttachmentSource(
	read: () => { conversationId: string; messages: SourceMessage[] } | null
): void {
	$effect.pre(() => {
		setAttachmentSource(read());
	});
	onDestroy(() => setAttachmentSource(null));
}

/**
 * Run `run` once the open conversation's attachments have settled in the
 * sandbox — mounted, or reported as not available on the chips. A mount that
 * fails never blocks the run, but the run does wait for it to finish failing:
 * code that starts while a file is still being fetched sees an empty
 * `/mnt/data`. With no conversation open `run` is called synchronously, as
 * it always was.
 */
export function withAttachmentMounts<T>(run: () => Promise<T>, code?: string): Promise<T> {
	const pending = conversationAttachments?.ensure(code);
	return pending ? pending.then(run, run) : run();
}
