/**
 * The composer's attachment machinery, shared by chat and any agent surface
 * (plan milestone M2a): what a paste turns into, and — for a surface that
 * stores its files before sending rather than inside the send — the upload.
 *
 * Picking is `ChatInput`'s own (`mimeTypes` + a bindable `files`), dropping
 * is `FileDropzone` plus `FileDrag`, and the chips are `ComposerFileChips`;
 * this module is the part with no markup. Nothing here knows about a
 * conversation, an endpoint or an agent transport: the caller supplies its
 * MIME allowlist and, to upload, its endpoint.
 */

import superjson from "superjson";

import type { MessageFile } from "$lib/types/Message";
import { mimeMatchesAllowlist } from "$lib/utils/mimeMatch";

/**
 * Pasted text at least this long becomes an attachment chip rather than
 * composer text, unless the person turned `directPaste` on.
 */
export const LONG_PASTE_CHARS = 3984;

/** Chat's type for a long paste turned into a chip (plain text). */
export const CLIPBOARD_MIME = "application/vnd.chatui.clipboard";

export interface PastedAttachments {
	/** Files to append to the composer's, in order. */
	files: File[];
	/** The paste produced attachments, so the browser must not also paste it. */
	preventDefault: boolean;
	/** The paste was long text turned into a chip — the composer's cue to flash. */
	longText: boolean;
}

/**
 * What one paste adds to the composer: a long text paste becomes a
 * clipboard chip, and pasted files are kept when the allowlist admits them
 * (wildcards included) and silently dropped otherwise.
 */
export function pastedAttachments(
	clipboard: DataTransfer | null,
	options: { mimeTypes: readonly string[]; directPaste?: boolean }
): PastedAttachments {
	const result: PastedAttachments = { files: [], preventDefault: false, longText: false };
	const textContent = clipboard?.getData("text");

	if (!options.directPaste && textContent && textContent.length >= LONG_PASTE_CHARS) {
		result.preventDefault = true;
		result.longText = true;
		result.files.push(new File([textContent], "Pasted Content", { type: CLIPBOARD_MIME }));
	}

	if (!clipboard) return result;

	const pastedFiles = Array.from(clipboard.files);
	if (pastedFiles.length !== 0) {
		result.preventDefault = true;
		result.files.push(
			...pastedFiles.filter((file) => mimeMatchesAllowlist(file.type, options.mimeTypes))
		);
	}
	return result;
}

/**
 * Store a message's files at the surface's own upload endpoint before the
 * message is sent, and return the `MessageFile` references to send and keep.
 *
 * The endpoint takes a multipart form of `messageId` plus one `files` entry
 * per file, and answers `{ files: MessageFile[] }` as superjson — the shape
 * of `/api/v2/code/attachments/[key]`. Throws with the server's message on
 * refusal (size, type, ownership), so the composer can show it.
 */
export async function uploadComposerFiles(
	endpoint: string,
	messageId: string,
	files: readonly File[],
	fetchImpl: typeof fetch = fetch
): Promise<MessageFile[]> {
	if (files.length === 0) return [];
	const form = new FormData();
	form.set("messageId", messageId);
	for (const file of files) form.append("files", file);
	const res = await fetchImpl(endpoint, { method: "POST", body: form });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(body?.message ?? `Upload failed (${res.status})`);
	}
	return superjson.parse<{ files: MessageFile[] }>(await res.text()).files;
}
