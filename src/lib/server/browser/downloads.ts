/**
 * Files the browser downloaded go into the conversation (ADR 0116 §5), through the same paths a
 * file a user attaches takes, so the privacy pipelines apply and a withheld file stays withheld.
 *
 * Each file is first written as a conversation attachment (`writeAttachment`): a document is
 * extracted there by the gateway, as the user, which is where Pystino's privacy pipelines read it
 * (ADR 0113), and a file one of them withholds is marked on its stored bytes, so no tool, sandbox
 * mount or re-extraction can read it (#193). Such a file is reported to the chat model as
 * withheld, never as saved. Anything else is also stored as a deliverable, which is what makes it
 * a file card in the chat and a name the document tools and the sandbox know (`/mnt/data/<name>`),
 * exactly like a file a connector returned (`mcp/resultFiles.ts`).
 */

import type { ObjectId } from "mongodb";
import { logger } from "$lib/server/logger";
import { writeAttachment } from "$lib/server/files/uploadFile";
import { withheldMessage } from "$lib/server/files/downloadFile";
import { MAX_DELIVERABLE_BYTES, storeDeliverable } from "$lib/server/execution/deliverables";
import { safeFileName, savedNote, notSavedNote } from "$lib/server/mcp/resultFiles";
import { MAX_DOWNLOAD_BYTES, type DownloadResult } from "./contract";
import type { BrowseFile } from "./loop";

export interface SaveDownloadsContext {
	conversationId: ObjectId;
	userId?: ObjectId;
	messageId?: string;
	/** The user's gateway token: reading a document is metered to them, like an attachment. */
	token?: string;
	/** Test seams. */
	attach?: typeof writeAttachment;
	store?: typeof storeDeliverable;
}

export async function saveBrowserDownloads(
	captured: DownloadResult["files"],
	ctx: SaveDownloadsContext
): Promise<BrowseFile[]> {
	const attach = ctx.attach ?? writeAttachment;
	const store = ctx.store ?? storeDeliverable;
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
		const bytes = Buffer.from(file.base64, "base64");
		if (bytes.byteLength > Math.min(MAX_DOWNLOAD_BYTES, MAX_DELIVERABLE_BYTES)) {
			out.push({
				name,
				size: bytes.byteLength,
				saved: false,
				note: notSavedNote("it is larger than the file size limit"),
			});
			continue;
		}
		try {
			const attached = await attach(
				new File([new Uint8Array(bytes)], name, { type: file.mime }),
				ctx.conversationId.toString(),
				ctx.token
			);
			if (attached.withheld) {
				out.push({
					name,
					size: bytes.byteLength,
					saved: false,
					note: `[a file named ${name} was downloaded and is withheld: ${withheldMessage(attached.withheld)}]`,
				});
				continue;
			}
			const stored = await store({
				conversationId: ctx.conversationId,
				userId: ctx.userId,
				name,
				mime: file.mime,
				bytes,
				tool: "browse",
				summary: "downloaded by the browser",
				messageId: ctx.messageId,
			});
			if (!stored.ok) {
				out.push({ name, size: bytes.byteLength, saved: false, note: notSavedNote(stored.error) });
				continue;
			}
			out.push({
				name: stored.ref.name,
				size: stored.ref.size,
				saved: true,
				note: savedNote(stored.ref.name, stored.ref.size),
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
