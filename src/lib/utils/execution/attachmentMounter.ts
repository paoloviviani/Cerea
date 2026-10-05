import { fetchWithinCap, OverCapError } from "./files";
import {
	MAX_ATTACHMENT_FILE_BYTES,
	checkAttachmentCaps,
	planAttachments,
	type AttachmentSource,
	type PlannedAttachment,
} from "./attachmentNames";
import { MOUNT_ROOT } from "./protocol";

/**
 * Mounts one conversation's chat attachments into the sandbox, bringing it up
 * to date with whatever the conversation holds now. Plain TypeScript with no
 * runes, so the same code runs under the real worker in a Node test.
 *
 * Bytes come from the route the chat already downloads attachments through
 * (`/conversation/<id>/output/<sha>`), which authenticates against the
 * conversation. A file attached in the turn that is still streaming has no
 * stored hash yet and is mounted from its own bytes; its extracted text
 * arrives with the next sync.
 */

export interface MounterSession {
	loadFiles(files: Array<{ name: string; data: ArrayBuffer | string }>): Promise<string[]>;
	removeFile(path: string): Promise<unknown>;
}

export interface MounterHooks {
	mounted(file: { path: string; name: string }): void;
	/** A file that was not mounted, and why, for the chips. */
	skipped(note: { name: string; reason: string }): void;
}

interface Entry {
	original: boolean;
	text: boolean;
	/** Over a cap: do not try again. Other failures are retried on the next sync. */
	refused: boolean;
	paths: string[];
}

const MB = 1024 * 1024;

function decodeBase64(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

export class AttachmentMounter {
	#entries = new Map<string, Entry>();
	#mountedBytes = 0;

	constructor(
		private readonly conversationId: string,
		private readonly session: MounterSession,
		private readonly hooks: MounterHooks
	) {}

	/** Whether a sync would do anything: new files, or text that has since arrived. */
	needsSync(files: readonly AttachmentSource[]): boolean {
		return planAttachments(files).some((planned) => {
			const entry = this.#entries.get(planned.name);
			if (entry?.refused) return false;
			return !entry?.original || (planned.textName !== undefined && !entry.text);
		});
	}

	/** Mount whatever of `files` is not mounted yet. Never throws. */
	async sync(files: readonly AttachmentSource[]): Promise<void> {
		for (const planned of planAttachments(files)) {
			const entry = this.#entries.get(planned.name) ?? {
				original: false,
				text: false,
				refused: false,
				paths: [],
			};
			this.#entries.set(planned.name, entry);
			if (entry.refused) continue;
			if (!entry.original) {
				const bytes = await this.fetchOriginal(entry, planned);
				if (!bytes || !(await this.mount(entry, planned.name, bytes))) continue;
				entry.original = true;
			}
			if (planned.textName && planned.file.extracted && !entry.text) {
				const bytes = await this.fetchHash(entry, planned.textName, planned.file.extracted.value);
				if (bytes && (await this.mount(entry, planned.textName, bytes))) entry.text = true;
			}
		}
	}

	/** Remove everything this mounter put in the sandbox; returns the paths. */
	async unmountAll(): Promise<string[]> {
		const removed: string[] = [];
		for (const entry of this.#entries.values()) {
			for (const path of entry.paths) {
				try {
					await this.session.removeFile(path);
					removed.push(path);
				} catch {
					// Already gone (a reset sandbox); nothing to take back.
				}
			}
		}
		this.#entries.clear();
		this.#mountedBytes = 0;
		return removed;
	}

	private async fetchOriginal(
		entry: Entry,
		planned: PlannedAttachment
	): Promise<ArrayBuffer | undefined> {
		const { file, name } = planned;
		if (file.type === "base64") {
			// Four characters carry three bytes; refuse before decoding a huge one.
			const size = Math.floor((file.value.length * 3) / 4);
			if (checkAttachmentCaps(0, size) === "file") {
				this.refuse(entry, name, size);
				return undefined;
			}
			return decodeBase64(file.value);
		}
		return this.fetchHash(entry, name, file.value);
	}

	private async fetchHash(
		entry: Entry,
		name: string,
		hash: string
	): Promise<ArrayBuffer | undefined> {
		try {
			return await fetchWithinCap(
				`/conversation/${this.conversationId}/output/${hash}`,
				MAX_ATTACHMENT_FILE_BYTES
			);
		} catch (err) {
			if (err instanceof OverCapError) {
				this.refuse(entry, name, err.bytes);
			} else {
				this.hooks.skipped({
					name,
					reason: err instanceof Error ? err.message : "could not be loaded",
				});
			}
			return undefined;
		}
	}

	private refuse(entry: Entry, name: string, bytes: number): void {
		const size = (bytes / MB).toFixed(1);
		this.hooks.skipped({
			name,
			reason: `${size} MB is over the ${MAX_ATTACHMENT_FILE_BYTES / MB} MB per-file limit`,
		});
		entry.refused = true;
	}

	private async mount(entry: Entry, name: string, bytes: ArrayBuffer): Promise<boolean> {
		const verdict = checkAttachmentCaps(this.#mountedBytes, bytes.byteLength);
		if (verdict !== "ok") {
			this.hooks.skipped({
				name,
				reason:
					verdict === "file"
						? `${(bytes.byteLength / MB).toFixed(1)} MB is over the ${MAX_ATTACHMENT_FILE_BYTES / MB} MB per-file limit`
						: "the conversation's files would pass the 100 MB total limit",
			});
			entry.refused = true;
			return false;
		}
		try {
			const [path] = await this.session.loadFiles([{ name, data: bytes }]);
			const mounted = path ?? `${MOUNT_ROOT}/${name}`;
			entry.paths.push(mounted);
			this.#mountedBytes += bytes.byteLength;
			this.hooks.mounted({ path: mounted, name });
			return true;
		} catch (err) {
			this.hooks.skipped({
				name,
				reason: err instanceof Error ? err.message : "the sandbox refused it",
			});
			return false;
		}
	}
}
