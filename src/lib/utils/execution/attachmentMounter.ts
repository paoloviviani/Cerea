import { fetchWithinCap, FetchFailedError, OverCapError } from "./files";
import {
	MAX_ATTACHMENT_FILE_BYTES,
	checkAttachmentCaps,
	planAttachments,
	type AttachmentSource,
	type PlannedAttachment,
} from "./attachmentNames";
import { MOUNT_ROOT, safeMountName } from "./protocol";

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
 *
 * The conversation's other files are mounted too: what the document tools and
 * the sandbox itself produced (`syncProduced`). A name has one file at
 * `/mnt/data/<name>`, the current version of it; a produced file replaces an
 * attachment of the same name there unless the attachment is the current
 * version — a re-uploaded attachment is the newest content of its name by
 * construction, and the document tools resolve a name to the current version.
 * Earlier versions are not mounted.
 */

/** One stored file of the conversation, as the list endpoint gives it. */
export interface ProducedFile {
	name: string;
	size: number;
	sha256: string;
	mime?: string;
	createdAt: string;
	/** When an older version was made the latest again (a restore). */
	latestAt?: string;
	/** Its number among the name's versions, when the row carries one. */
	version?: number;
}

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
	/** Over the per-file cap: do not try again. Other failures are retried on the next sync. */
	refused: boolean;
	/**
	 * Turned away because the conversation's total was full: the mounted total
	 * at that moment. Tried again only once the total is below it (space freed).
	 */
	blockedAt?: number;
	paths: string[];
	/** What the original and its text count against the total. */
	originalBytes: number;
	textBytes: number;
	textPath?: string;
	/** The attachment's number among its name's versions: 1 when it carries none. */
	version: number;
}

const MB = 1024 * 1024;

/** A produced file's download gives up after this long; the run goes ahead without it. */
export const PRODUCED_DOWNLOAD_TIMEOUT_MS = 30_000;

/** Whether the code names a file, which is when an image output is worth mounting. */
function mentions(code: string | undefined, name: string): boolean {
	return code !== undefined && code.includes(name);
}

function decodeBase64(value: string): ArrayBuffer {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
	return bytes.buffer;
}

export class AttachmentMounter {
	#entries = new Map<string, Entry>();
	/** Mount name -> the produced version mounted there. */
	#produced = new Map<string, { sha256: string; path: string; bytes: number }>();
	/** Produced versions over the per-file cap: not tried again. */
	#refused = new Set<string>();
	/** Produced versions turned away for want of room: the mounted total then; retried once it is lower. */
	#blocked = new Map<string, number>();
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
			if (entry?.blockedAt !== undefined && this.#mountedBytes >= entry.blockedAt) return false;
			return !entry?.original || (planned.textName !== undefined && !entry.text);
		});
	}

	/**
	 * Mount whatever of `files` is not mounted yet. Never throws: a file that
	 * fails for any reason — a bad response, an undecodable inline payload, a
	 * sandbox that refuses it — is reported through `skipped` and the rest go on.
	 */
	async sync(files: readonly AttachmentSource[]): Promise<void> {
		for (const planned of planAttachments(files)) {
			try {
				await this.syncOne(planned);
			} catch (err) {
				console.warn(`[attachments] ${planned.name} could not be mounted:`, err);
				this.hooks.skipped({
					name: planned.name,
					reason: err instanceof Error ? err.message : "could not be mounted",
				});
			}
		}
	}

	private async syncOne(planned: PlannedAttachment): Promise<void> {
		const entry = this.#entries.get(planned.name) ?? {
			original: false,
			text: false,
			refused: false,
			paths: [],
			originalBytes: 0,
			textBytes: 0,
			version: 1,
		};
		this.#entries.set(planned.name, entry);
		entry.version = planned.file.version ?? 1;
		if (entry.refused) return;
		if (entry.blockedAt !== undefined) {
			// Waiting for room: nothing to try until the total has dropped below where it was.
			if (this.#mountedBytes >= entry.blockedAt) return;
			entry.blockedAt = undefined;
		}
		if (!entry.original) {
			const bytes = await this.fetchOriginal(entry, planned);
			if (!bytes || !(await this.mount(entry, planned.name, bytes))) return;
			entry.original = true;
			entry.originalBytes = bytes.byteLength;
			// Written over whatever produced file held this name: it is mounted again below.
			this.#produced.delete(planned.name);
		}
		if (planned.textName && planned.file.extracted && !entry.text) {
			const bytes = await this.fetchHash(entry, planned.textName, planned.file.extracted.value);
			if (bytes && (await this.mount(entry, planned.textName, bytes))) {
				entry.text = true;
				entry.textBytes = bytes.byteLength;
				entry.textPath = entry.paths.at(-1);
			}
		}
	}

	/**
	 * Mount the current version of each produced file, replacing an older
	 * version of the same name — or an attachment of that name, unless the
	 * attachment is the current version: a re-uploaded attachment is newer
	 * than every row that existed when it was numbered, and the tools resolve
	 * the name to the current version, so the attachment stays mounted. Never
	 * throws, like `sync`.
	 *
	 * Image outputs (the figures a run draws, charts the tools saved) are not
	 * mounted unless `code` names them: they are the bulk of a long
	 * conversation's files and almost never an input to the next run. Not
	 * mounting is not a refusal, so no note is shown, and a later run that does
	 * name the image mounts it then.
	 */
	async syncProduced(
		listed: readonly ProducedFile[],
		options: { code?: string } = {}
	): Promise<void> {
		const latest = new Map<string, ProducedFile>();
		for (const file of listed) {
			const name = safeMountName(file.name);
			if (!name) continue;
			const at = (f: ProducedFile) => Date.parse(f.latestAt ?? f.createdAt) || 0;
			const best = latest.get(name);
			if (!best || at(file) >= at(best)) latest.set(name, file);
		}
		for (const [name, file] of latest) {
			const held = this.#produced.get(name);
			if (held?.sha256 === file.sha256 || this.#refused.has(file.sha256)) continue;
			const blocked = this.#blocked.get(file.sha256);
			if (blocked !== undefined && this.#mountedBytes >= blocked) continue;
			if (file.mime?.startsWith("image/") && !mentions(options.code, name)) continue;
			// The mounted attachment is the current version of the name: a row
			// with a lower number is an earlier version. A row with no number is
			// treated as the newer one — the back-fill has not reached it, and an
			// unnumbered row can only predate numbers, never a stamped upload.
			const attachment = this.#entries.get(name);
			if (attachment?.original && file.version !== undefined && attachment.version > file.version)
				continue;
			try {
				await this.mountProduced(name, file, held);
			} catch (err) {
				console.warn(`[attachments] ${name} could not be mounted:`, err);
				this.hooks.skipped({
					name,
					reason: err instanceof Error ? err.message : "could not be mounted",
				});
			}
		}
	}

	private async mountProduced(
		name: string,
		file: ProducedFile,
		held: { path: string; bytes: number } | undefined
	): Promise<void> {
		// What the file replaces gives its bytes back to the total before the check.
		const attachment = this.#entries.get(name);
		const released =
			(held?.bytes ?? 0) + (attachment ? attachment.originalBytes + attachment.textBytes : 0);
		const others = this.#mountedBytes - released;
		const verdict = checkAttachmentCaps(others, file.size);
		if (verdict !== "ok") return this.turnAway(name, file, verdict, file.size);

		const url = `/conversation/${this.conversationId}/code-execution/output/${file.sha256}`;
		let bytes: ArrayBuffer;
		try {
			bytes = await fetchWithinCap(
				url,
				MAX_ATTACHMENT_FILE_BYTES,
				AbortSignal.timeout(PRODUCED_DOWNLOAD_TIMEOUT_MS)
			);
		} catch (err) {
			if (err instanceof OverCapError) {
				this.turnAway(name, file, "file", err.bytes);
			} else {
				const status = err instanceof FetchFailedError ? ` (status ${err.status})` : "";
				console.warn(`[attachments] ${name} was not fetched from ${url}${status}:`, err);
				this.hooks.skipped({
					name,
					reason:
						err instanceof Error && err.name === "TimeoutError"
							? "it took too long to load; it will be tried again on the next run"
							: err instanceof Error
								? err.message
								: "could not be loaded",
				});
			}
			return;
		}
		const real = checkAttachmentCaps(others, bytes.byteLength);
		if (real !== "ok") return this.turnAway(name, file, real, bytes.byteLength);

		const [path] = await this.session.loadFiles([{ name, data: bytes }]);
		const mounted = path ?? `${MOUNT_ROOT}/${name}`;
		if (attachment) {
			// The produced file now holds the attachment's path. Its extracted text
			// beside it (`<name>.md`) describes the old bytes: take it out.
			attachment.originalBytes = 0;
			if (attachment.textPath) {
				await this.session.removeFile(attachment.textPath).catch(() => undefined);
				attachment.paths = attachment.paths.filter((p) => p !== attachment.textPath);
				attachment.textPath = undefined;
				attachment.textBytes = 0;
				// Done with, not missing: the next sync must not fetch it again.
				attachment.text = true;
			}
		}
		this.#mountedBytes = others + bytes.byteLength;
		this.#produced.set(name, { sha256: file.sha256, path: mounted, bytes: bytes.byteLength });
		this.hooks.mounted({ path: mounted, name });
	}

	/** Say why a produced file is not mounted; only an over-size file is final. */
	private turnAway(
		name: string,
		file: ProducedFile,
		verdict: "file" | "total",
		bytes: number
	): void {
		if (verdict === "file") this.#refused.add(file.sha256);
		else this.#blocked.set(file.sha256, this.#mountedBytes);
		this.hooks.skipped({
			name,
			reason:
				verdict === "file"
					? `${(bytes / MB).toFixed(1)} MB is over the ${MAX_ATTACHMENT_FILE_BYTES / MB} MB per-file limit`
					: "the conversation's files would pass the 100 MB total limit",
		});
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
		for (const { path } of this.#produced.values()) {
			try {
				await this.session.removeFile(path);
				removed.push(path);
			} catch {
				// Already gone.
			}
		}
		this.#entries.clear();
		this.#produced.clear();
		this.#refused.clear();
		this.#blocked.clear();
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
		const url = `/conversation/${this.conversationId}/output/${hash}`;
		try {
			return await fetchWithinCap(url, MAX_ATTACHMENT_FILE_BYTES);
		} catch (err) {
			if (err instanceof OverCapError) {
				this.refuse(entry, name, err.bytes);
			} else {
				// Names the URL and the status: the chip says which file and why, but
				// not which request, and that is what a missing /mnt/data entry
				// gets debugged from.
				const status = err instanceof FetchFailedError ? ` (status ${err.status})` : "";
				console.warn(`[attachments] ${name} was not fetched from ${url}${status}:`, err);
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
			if (verdict === "file") entry.refused = true;
			else entry.blockedAt = this.#mountedBytes;
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
			console.warn(`[attachments] the sandbox did not take ${name}:`, err);
			this.hooks.skipped({
				name,
				reason: err instanceof Error ? err.message : "the sandbox refused it",
			});
			return false;
		}
	}
}
