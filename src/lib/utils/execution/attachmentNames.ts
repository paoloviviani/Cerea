import { MOUNT_ROOT, safeMountName } from "./protocol";

/**
 * Where a chat attachment lands in the execution sandbox, decided in one
 * place. The browser mounts by this plan and the server tells the model the
 * path from the same plan, so the two cannot disagree about a name — which is
 * the whole point: a path in the prompt that is not the path on disk sends
 * model-written code to open a file that is not there.
 *
 * Pure and dependency-free on purpose (protocol.ts is constants and a string
 * helper), so it runs unchanged in the server's prompt builder and the
 * browser's mounter.
 */

/** One attachment is never mounted above this size; it is skipped and noted. */
export const MAX_ATTACHMENT_FILE_BYTES = 30 * 1024 * 1024;

/** A conversation mounts at most this much in total (originals plus text). */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 100 * 1024 * 1024;

/** Pasted text: mounted as a text file, so code can read what is too large to inline. */
const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

/** The worker clips a mount name to this many characters (safeMountName). */
const MAX_NAME_CHARS = 120;

/** A trailing ".xyz" this short is an extension; anything longer is just a name. */
const MAX_EXTENSION_CHARS = 16;

/** What the plan needs of a message file: structurally a `MessageFile`. */
export interface AttachmentSource {
	type: "hash" | "base64";
	name: string;
	value: string;
	mime?: string;
	extracted?: { value: string };
	/** A privacy rule withheld this file: it is never mounted or planned. */
	withheld?: { rule: string; pipeline?: string };
	/** The name's version this file is, when it was numbered at upload (1 needs no record). */
	version?: number;
	/**
	 * When the message carrying it was sent (ms), when the caller knows it. The same content
	 * attached again later is one mount under its first name; its plan entry keeps the LATEST
	 * time, so a re-sent file counts as sent at its last sending.
	 */
	sentAt?: number;
}

export interface PlannedAttachment {
	file: AttachmentSource;
	/** The latest `sentAt` among the files this one stands for (see `AttachmentSource.sentAt`). */
	sentAt?: number;
	/** The original bytes' file name under /mnt/data. */
	name: string;
	/** The extracted text's file name (`<name>.md`), when the file has any. */
	textName?: string;
}

function split(name: string): { stem: string; ext: string } {
	const dot = name.lastIndexOf(".");
	if (dot > 0 && name.length - dot <= MAX_EXTENSION_CHARS) {
		return { stem: name.slice(0, dot), ext: name.slice(dot) };
	}
	return { stem: name, ext: "" };
}

/** `name`, or `stem (2).ext`, `stem (3).ext`… the first one not already used. */
function allocate(used: Set<string>, wanted: string): string {
	let chosen = wanted;
	if (used.has(chosen)) {
		const { stem, ext } = split(wanted);
		for (let n = 2; ; n += 1) {
			const suffix = ` (${n})`;
			const room = Math.max(1, MAX_NAME_CHARS - suffix.length - ext.length);
			chosen = `${stem.slice(0, room)}${suffix}${ext}`;
			if (!used.has(chosen)) break;
		}
	}
	used.add(chosen);
	return chosen;
}

/**
 * A paste's file name: `pasted-<n>.txt`, or `.json` when the composer named it
 * so (it does when the text starts like JSON). `n` counts the conversation's
 * pastes in order.
 */
function pastedName(name: string, n: number): string {
	return `pasted-${n}${name.toLowerCase().endsWith(".json") ? ".json" : ".txt"}`;
}

/**
 * Plan the mount of every attachment in a conversation, given its files in
 * message order. Files carry their original name; one that the sandbox cannot
 * hold as written is cleaned the way the worker would clean it, and a name
 * already taken gets a ` (2)` before its extension. The extracted text sits
 * beside its file as `<name>.md`.
 *
 * The same file attached twice (same stored hash, or the same inline bytes)
 * is one mount; a different file with a name already taken is suffixed. A paste is a
 * text file named `pasted-<n>`; page images of scanned PDFs (never top-level files)
 * are not planned.
 */
export function planAttachments(files: readonly AttachmentSource[]): PlannedAttachment[] {
	const used = new Set<string>();
	const seen = new Map<string, PlannedAttachment | undefined>();
	const plan: PlannedAttachment[] = [];
	let pastes = 0;
	for (const file of files) {
		if (file.withheld) continue;
		// The same content attached again is one mount under its first name; a
		// different file with the same name gets the next free " (n)" name below.
		const identity = `${file.type}:${file.value}`;
		if (seen.has(identity)) {
			const first = seen.get(identity);
			if (first && file.sentAt !== undefined && file.sentAt > (first.sentAt ?? -Infinity)) {
				first.sentAt = file.sentAt;
			}
			continue;
		}
		const isPaste = file.mime === CLIPBOARD_MIME;
		if (isPaste) pastes += 1;
		const name = allocate(
			used,
			isPaste ? pastedName(file.name, pastes) : (safeMountName(file.name) ?? "attachment")
		);
		let textName: string | undefined;
		if (file.extracted) {
			const wanted =
				name.length + 3 > MAX_NAME_CHARS ? `${name.slice(0, MAX_NAME_CHARS - 3)}.md` : `${name}.md`;
			textName = allocate(used, wanted);
		}
		const entry: PlannedAttachment = {
			file,
			name,
			textName,
			...(file.sentAt !== undefined ? { sentAt: file.sentAt } : {}),
		};
		seen.set(identity, entry);
		plan.push(entry);
	}
	return plan;
}

/**
 * Stored file hash → mount name, for the prompt's side of the agreement.
 *
 * With `sizes` (stored bytes by hash) it also applies the caps exactly as the
 * browser's mounter does — files in plan order, a file's text counted after
 * its original, a refused file not counted — and leaves out every file the
 * browser will not mount, so the model is never pointed at a path that does
 * not exist. A file with no known size is left out too: it cannot be fetched.
 */
export function mountNamesByHash(
	files: readonly AttachmentSource[],
	sizes?: ReadonlyMap<string, number>
): Map<string, string> {
	return new Map([...mountPlanByHash(files, sizes)].map(([hash, mount]) => [hash, mount.name]));
}

/**
 * `mountNamesByHash` with the extracted text's name too, when that text is
 * mounted beside the original (`<name>.md`).
 */
export function mountPlanByHash(
	files: readonly AttachmentSource[],
	sizes?: ReadonlyMap<string, number>
): Map<string, { name: string; textName?: string }> {
	const names = new Map<string, { name: string; textName?: string }>();
	let mounted = 0;
	for (const planned of planAttachments(files)) {
		if (planned.file.type !== "hash") continue;
		let textName: string | undefined;
		if (sizes) {
			const size = sizes.get(planned.file.value);
			if (size === undefined || checkAttachmentCaps(mounted, size) !== "ok") continue;
			mounted += size;
			const textHash = planned.file.extracted?.value;
			const textSize = textHash ? sizes.get(textHash) : undefined;
			if (textSize !== undefined && checkAttachmentCaps(mounted, textSize) === "ok") {
				mounted += textSize;
				textName = planned.textName;
			}
		} else {
			textName = planned.textName;
		}
		names.set(planned.file.value, { name: planned.name, ...(textName ? { textName } : {}) });
	}
	return names;
}

/** The one line the model reads, when the code tool is on offer. */
export function attachmentMountNotice(name: string): string {
	return `Its full text is below, already read. The file is also available to code at ${MOUNT_ROOT}/${name} (its current version, if it has been edited), for computation such as counting, searching at scale or transforming, not to read it again.`;
}

export type CapVerdict = "ok" | "file" | "total";

/** Whether `size` more bytes fit under both caps, `mountedBytes` already in. */
export function checkAttachmentCaps(mountedBytes: number, size: number): CapVerdict {
	if (size > MAX_ATTACHMENT_FILE_BYTES) return "file";
	if (mountedBytes + size > MAX_ATTACHMENTS_TOTAL_BYTES) return "total";
	return "ok";
}
