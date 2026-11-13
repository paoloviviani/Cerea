import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { downloadFile, storedSizes } from "$lib/server/files/downloadFile";
import { branchOf } from "$lib/server/execution/fileVersions";
import { checkAttachmentCaps, planAttachments } from "$lib/utils/execution/attachmentNames";
import type { MessageFile } from "$lib/types/Message";
import type { StageFile } from "./sandboxSessions";

/**
 * What a conversation's sandbox should hold in /mnt/data: the attachments the browser's mounter
 * would mount, by the same plan (`planAttachments`, the same names and the same caps), so the
 * path the model was told is the path on disk.
 *
 * Never a file a privacy rule withheld (#193): the plan skips a file the message marks withheld,
 * and `downloadFile` refuses any stored entry carrying a withholding, so a file never reaches the
 * sandbox by either door. Bytes are read only when a file is first staged (`load` is lazy).
 *
 * Not staged yet: files the document tools produced (the browser mounts those too).
 */
export async function attachmentsToStage(
	conversationId: ObjectId,
	messageId?: string
): Promise<StageFile[]> {
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId },
		{ projection: { messages: 1, createdAt: 1 } }
	);
	const branch = await branchOf(conversationId, messageId);
	const fallback = conversation?.createdAt ?? new Date(0);
	const files: Array<MessageFile & { sentAt: number }> = (conversation?.messages ?? [])
		.filter((message) => !branch || branch.has(message.id))
		.flatMap((message) =>
			(message.files ?? []).map((file) => ({
				...file,
				sentAt: (message.createdAt ?? fallback).getTime(),
			}))
		);
	const plan = planAttachments(files).filter((entry) => entry.file.type === "hash");
	if (plan.length === 0) return [];

	const hashes = plan.flatMap((entry) =>
		entry.file.extracted ? [entry.file.value, entry.file.extracted.value] : [entry.file.value]
	);
	const sizes = await storedSizes(hashes, conversationId);

	const staged: StageFile[] = [];
	let total = 0;
	const stage = (name: string, sha: string) => {
		staged.push({
			name,
			identity: `hash:${sha}`,
			async load() {
				const file = await downloadFile(sha, conversationId);
				return new Uint8Array(Buffer.from(file.value, "base64"));
			},
		});
	};
	for (const entry of plan) {
		const size = sizes.get(entry.file.value);
		// A file with no stored size cannot be fetched; one over a cap is left out, as in the browser.
		if (size === undefined || checkAttachmentCaps(total, size) !== "ok") continue;
		total += size;
		stage(entry.name, entry.file.value);
		const text = entry.file.extracted?.value;
		const textSize = text ? sizes.get(text) : undefined;
		if (
			entry.textName &&
			text &&
			textSize !== undefined &&
			checkAttachmentCaps(total, textSize) === "ok"
		) {
			total += textSize;
			stage(entry.textName, text);
		}
	}
	return staged;
}
