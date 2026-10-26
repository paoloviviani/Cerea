import type { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { downloadDeliverable } from "$lib/server/execution/deliverables";
import { downloadFile } from "$lib/server/files/downloadFile";
import type { MessageFile } from "$lib/types/Message";
import { planAttachments } from "$lib/utils/execution/attachmentNames";
import { MOUNT_ROOT } from "$lib/utils/execution/protocol";

/** The name as the model sees it for a file in the sandbox: `/mnt/data/<name>` or the bare name. */
export function bareName(reference: string): string {
	const trimmed = reference.trim();
	return trimmed.startsWith(`${MOUNT_ROOT}/`) ? trimmed.slice(MOUNT_ROOT.length + 1) : trimmed;
}

export type ConversationFile =
	| {
			ok: true;
			name: string;
			bytes: Buffer;
			sha256: string;
			/** An attachment the person sent, or a file a run or a tool produced. */
			origin: "attachment" | "output";
	  }
	| { ok: false; error: string };

/**
 * A file the conversation already has, by the name the model knows it under:
 * an attachment (the name in "available to code at /mnt/data/<name>") or a file
 * a run or a tool produced.
 *
 * Only this conversation's store is searched, and each read is checked against
 * the conversation again (`downloadFile`, `downloadDeliverable`), so a name or
 * a hash that belongs to somebody else's conversation is "not found", never
 * their bytes.
 *
 * `prefer` says which wins when an attachment and a produced file carry the
 * same name. `convert_document` keeps the attachment first; the document tools
 * take the newest produced file first, because an edit is saved under its
 * source's name as the next version and the next edit must start from it.
 */
export async function findConversationFile(
	conversationId: ObjectId,
	reference: string,
	options: { prefer?: "attachment" | "output" } = {}
): Promise<ConversationFile> {
	const wanted = bareName(reference);
	const conversation = await collections.conversations.findOne(
		{ _id: conversationId },
		{ projection: { messages: 1 } }
	);
	const files: MessageFile[] = (conversation?.messages ?? []).flatMap(
		(message) => message.files ?? []
	);
	const planned = planAttachments(files).find(
		(entry) => entry.file.type === "hash" && (entry.name === wanted || entry.file.name === wanted)
	);

	const fromAttachment = async (): Promise<ConversationFile | undefined> => {
		if (!planned) return undefined;
		const stored = await downloadFile(planned.file.value, conversationId.toString()).catch(
			() => undefined
		);
		if (!stored) return undefined;
		return {
			ok: true,
			name: planned.file.name,
			bytes: Buffer.from(stored.value, "base64"),
			sha256: planned.file.value,
			origin: "attachment",
		};
	};
	const fromOutput = async (): Promise<ConversationFile | undefined> => {
		const row = await collections.codeExecutionOutputs
			.find({ conversationId, name: wanted })
			.sort({ createdAt: -1 })
			.limit(1)
			.next();
		if (!row) return undefined;
		const bytes = (await downloadDeliverable(conversationId, row.sha256))?.buffer;
		return bytes
			? { ok: true, name: row.name, bytes, sha256: row.sha256, origin: "output" }
			: undefined;
	};

	// Same behaviour as before the document tools: an attachment found in the
	// plan is the answer even if its bytes are gone (the output store is not tried).
	let found: ConversationFile | undefined;
	if (options.prefer === "output") {
		found = (await fromOutput()) ?? (await fromAttachment());
	} else {
		found = planned ? await fromAttachment() : await fromOutput();
	}
	return (
		found ?? {
			ok: false,
			error: `No file named "${wanted}" in this conversation. Use the name of an attachment or of a file you produced.`,
		}
	);
}
