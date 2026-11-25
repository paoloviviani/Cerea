import { collections } from "$lib/server/database";
import { sha256 } from "$lib/utils/sha256";

/**
 * What `doc_extract` read out of a file once, kept so the same bytes are never sent to the reader
 * (priced per page) twice.
 *
 * It lives in the chat blob store beside the upload's own extracted text, one entry per read (a page
 * set, or the whole text), keyed by the content hash and the reader that actually read it, and tagged
 * `metadata.conversation`. Lifetime: the conversation's. `deleteConversationAttachments` and the orphan
 * sweep remove it with the rest of the conversation's files; it is not tied to one version of one file
 * (two files with the same bytes share it, which is the point).
 *
 * The filename is `extract:<conversation>:<digest>`, not the `<conversation>-<sha>` shape of attachments,
 * so no file route can resolve a cache entry by a hash it is given.
 *
 * Like an upload's text, a kept text is not re-checked when a privacy rule changes later; the chat
 * request that carries it to a model is checked by the gateway's rules as ever.
 */
export interface CachedExtraction {
	/** The page text by 1-based page number; absent for an unpaged read. */
	pages?: Record<number, string>;
	/** The pages the document has, when known. */
	total?: number;
	/** The whole text, for a reader that returns no page boundaries. */
	text?: string;
	readerModel?: string;
}

/** The pages a cache holds, merged over every read of these bytes by this reader. */
export interface MergedExtraction {
	pages: Map<number, string>;
	total?: number;
	/** Present when a read gave the whole text unpaged: it answers every request. */
	text?: string;
	readerModel?: string;
}

async function entryName(
	conversationId: string,
	contentSha: string,
	reader: string,
	range: string
) {
	return `extract:${conversationId}:${await sha256(`${contentSha}|${reader}|${range}`)}`;
}

export async function getCachedExtraction(
	conversationId: string,
	contentSha: string,
	reader: string
): Promise<MergedExtraction | null> {
	const entries = await collections.blobStore.find("files", {
		"metadata.conversation": conversationId,
		"metadata.extractCache": true,
		"metadata.extractedFrom": contentSha,
		"metadata.reader": reader,
	});
	if (entries.length === 0) return null;
	const merged: MergedExtraction = { pages: new Map() };
	for (const entry of entries) {
		try {
			const value = JSON.parse(
				(await collections.blobStore.read("files", entry.id)).toString("utf-8")
			) as CachedExtraction;
			if (typeof value.text === "string") merged.text = value.text;
			for (const [page, text] of Object.entries(value.pages ?? {})) {
				if (typeof text === "string") merged.pages.set(Number(page), text);
			}
			if (typeof value.total === "number") merged.total = Math.max(merged.total ?? 0, value.total);
			merged.readerModel ??= value.readerModel;
		} catch {
			// An unreadable entry is a miss, not a failure.
		}
	}
	return merged.text !== undefined || merged.pages.size > 0 ? merged : null;
}

export async function putCachedExtraction(
	conversationId: string,
	contentSha: string,
	reader: string,
	value: CachedExtraction
): Promise<void> {
	const range =
		value.text !== undefined
			? "all"
			: Object.keys(value.pages ?? {})
					.map(Number)
					.sort((a, b) => a - b)
					.join(",");
	const filename = await entryName(conversationId, contentSha, reader, range);
	if (await collections.blobStore.findOne("files", { filename })) return;
	await collections.blobStore.put(
		"files",
		{
			filename,
			metadata: {
				conversation: conversationId,
				mime: "application/json",
				extractCache: true,
				extractedFrom: contentSha,
				reader,
			},
		},
		Buffer.from(JSON.stringify(value), "utf-8")
	);
}
