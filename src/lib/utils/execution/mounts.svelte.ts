import { untrack } from "svelte";
import { getExecutionSession } from "./runtime";
import { mountConversationFile, mountKnowledgeFile, type KnowledgeFileRef } from "./files";
import { MOUNT_ROOT } from "./protocol";

/**
 * The files currently mounted into the runtime at /mnt/data.
 *
 * The worker's filesystem is session-global — chat blocks and artifact cells
 * share one interpreter — so the record of what is mounted is global too: a
 * file mounted for an artifact's analysis is equally visible to the next code
 * block, and the chips here are the only inventory of that.
 */

export interface MountedFile {
	path: string;
	name: string;
}

/** A conversation attachment that was left out of the sandbox, and why. */
export interface SkippedFile {
	name: string;
	reason: string;
}

class MountsStore {
	#files = $state<MountedFile[]>([]);
	#busy = $state(false);
	#skipped = $state<SkippedFile[]>([]);
	/** Paths put here by the conversation's attachments, so a switch takes back only those. */
	#conversationPaths = new Set<string>();

	get skipped(): SkippedFile[] {
		return this.#skipped;
	}

	get files(): MountedFile[] {
		return this.#files;
	}

	get busy(): boolean {
		return this.#busy;
	}

	get pathPrefix(): string {
		return MOUNT_ROOT;
	}

	/** Mount one knowledge document's indexed text at /mnt/data/<filename>. */
	async addKnowledge(ref: KnowledgeFileRef): Promise<MountedFile | undefined> {
		const session = getExecutionSession();
		if (!session) return undefined;
		this.#busy = true;
		try {
			const mounted = await mountKnowledgeFile(session, ref);
			this.record(mounted);
			return mounted;
		} finally {
			this.#busy = false;
		}
	}

	/** Mount a file attached to a conversation message. */
	async addConversationFile(
		conversationId: string,
		file: { name: string; value: string }
	): Promise<MountedFile | undefined> {
		const session = getExecutionSession();
		if (!session) return undefined;
		this.#busy = true;
		try {
			const mounted = await mountConversationFile(session, conversationId, file);
			this.record(mounted);
			return mounted;
		} finally {
			this.#busy = false;
		}
	}

	async remove(path: string): Promise<void> {
		const session = getExecutionSession();
		if (!session) return;
		this.#busy = true;
		try {
			await session.removeFile(path);
			untrack(() => {
				this.#files = this.#files.filter((file) => file.path !== path);
			});
		} finally {
			this.#busy = false;
		}
	}

	/** A chat attachment mounted for the open conversation. */
	recordConversationFile(mounted: MountedFile): void {
		this.#conversationPaths.add(mounted.path);
		untrack(() => {
			this.#skipped = this.#skipped.filter((note) => note.name !== mounted.name);
		});
		this.record(mounted);
	}

	/** A chat attachment that was not mounted; one note per name. */
	recordSkipped(note: SkippedFile): void {
		untrack(() => {
			this.#skipped = [...this.#skipped.filter((other) => other.name !== note.name), note];
		});
	}

	/**
	 * Forget the conversation's attachments (the sandbox side is removed by
	 * the caller): the chips and notes of the conversation just left. Knowledge
	 * and artifact mounts are untouched.
	 */
	dropConversationFiles(): void {
		untrack(() => {
			this.#files = this.#files.filter((file) => !this.#conversationPaths.has(file.path));
			this.#skipped = [];
		});
		this.#conversationPaths.clear();
	}

	private record(mounted: MountedFile): void {
		untrack(() => {
			// Re-mounting the same name replaces the bytes; keep one chip per path.
			this.#files = [...this.#files.filter((file) => file.path !== mounted.path), mounted];
		});
	}
}

let store: MountsStore | undefined;

/** Browser-only; undefined during SSR. */
export function getMountsStore(): MountsStore | undefined {
	if (typeof window === "undefined") return undefined;
	store ??= new MountsStore();
	return store;
}
