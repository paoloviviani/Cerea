/**
 * Files the browser downloaded go into the conversation (ADR 0116 §5), through the same path a
 * file a user attaches takes, once.
 *
 * Each file is written as a conversation attachment (`writeAttachment`): a document is extracted
 * there by the gateway, as the user, which is where Pystino's privacy pipelines read it
 * (ADR 0113), and a file one of them withholds is marked on its stored bytes, so no tool, sandbox
 * mount or re-extraction can read it (#193). Audio is stored as it is (no transcription: nobody
 * asked for one, and it is metered). The attachment is then listed on the assistant's message
 * with a `File` update, which is what makes it a name the document tools and the sandbox know
 * (`/mnt/data/<name>`); a withheld file is listed too, marked, and reported to the chat model as
 * withheld, never as saved. Nothing is stored twice.
 */

import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { writeAttachment } from "$lib/server/files/uploadFile";
import { withheldMessage } from "$lib/server/files/downloadFile";
import { safeFileName, savedNote, notSavedNote } from "$lib/server/mcp/resultFiles";
import { MessageUpdateType, type MessageFileUpdate } from "$lib/types/MessageUpdate";
import { MAX_DOWNLOAD_BYTES, type DownloadResult } from "./contract";
import type { BrowseFile } from "./loop";

export interface SaveDownloadsContext {
	conversationId: ObjectId;
	/** The user's gateway token: reading a document is metered to them, like an attachment. */
	token?: string;
	/** Where the `File` update goes, so the file is listed on the message. */
	emitFile?: (update: MessageFileUpdate) => void;
	/** Test seam. */
	attach?: typeof writeAttachment;
}

const MAX_BYTES = MAX_DOWNLOAD_BYTES;

export async function saveBrowserDownloads(
	captured: DownloadResult["files"],
	ctx: SaveDownloadsContext
): Promise<BrowseFile[]> {
	const attach = ctx.attach ?? writeAttachment;
	const out: BrowseFile[] = [];
	for (const file of captured) {
		const name = safeFileName(file.name) || "download";
		if (file.base64 === undefined) {
			out.push({
				name,
				size: file.size,
				saved: false,
				note: notSavedNote(file.skipped ?? "the browser left it out"),
			});
			continue;
		}
		// Checked on the text, before decoding it into memory.
		if (Math.floor((file.base64.length * 3) / 4) > MAX_BYTES) {
			out.push({
				name,
				size: file.size,
				saved: false,
				note: notSavedNote("it is larger than the file size limit"),
			});
			continue;
		}
		const bytes = Buffer.from(file.base64, "base64");
		try {
			const attached = await attach(
				new File([new Uint8Array(bytes)], name, { type: file.mime }),
				ctx.conversationId.toString(),
				ctx.token,
				undefined,
				{ skipTranscription: true }
			);
			if (attached.type === "hash") {
				ctx.emitFile?.({
					type: MessageUpdateType.File,
					name,
					sha: attached.value,
					mime: attached.mime,
					...(attached.withheld ? { withheld: attached.withheld } : {}),
				});
			}
			if (attached.withheld) {
				out.push({
					name,
					size: bytes.byteLength,
					saved: false,
					note: `[a file named ${name} was downloaded and is withheld: ${withheldMessage(attached.withheld)}]`,
				});
				continue;
			}
			out.push({
				name,
				size: bytes.byteLength,
				saved: true,
				note: savedNote(name, bytes.byteLength),
			});
		} catch (err) {
			logger.warn({ err: String(err), name }, "browse_download_not_saved");
			out.push({
				name,
				size: bytes.byteLength,
				saved: false,
				note: notSavedNote(err instanceof Error ? err.message : "the store failed"),
			});
		}
	}
	return out;
}
