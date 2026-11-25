import { collections } from "$lib/server/database";
import { sha256 } from "$lib/utils/sha256";

/**
 * What `doc_extract` read out of a file once, kept so the same bytes are never sent to the reader
 * (priced per page) twice.
 *
 * It lives in the chat blob store beside the upload's own extracted text, as one entry per
 * (content hash, reader choice), tagged `metadata.conversation` like every other file of the
 * conversation: deleting the conversation (`deleteConversationAttachments`) and the orphan sweep take it
 * with the rest, and nothing else lists it (no `messageId`, no `<conversation>-<sha>` name that a file
 * route would resolve). The entry holds every page's text, so a later request for other pages of the
 * same file is served from it too.
 */
export interface CachedExtraction {
	/** Text of each page, in page order. */
	pages: string[];
	/** The reader that produced it, when known (a gateway model id). */
	readerModel?: string;
	readerFallback?: boolean;
}

async function entryName(conversationId: string, contentSha: string, reader: string) {
	return `${conversationId}-extract-${await sha256(`${contentSha}|${reader}`)}`;
}

/** The reader part of the cache key: the user's chosen reader, or the deployment's default. */
export function readerKey(readerModel: string | null | undefined): string {
	return readerModel?.trim() || "default";
}

export async function getCachedExtraction(
	conversationId: string,
	contentSha: string,
	reader: string
): Promise<CachedExtraction | null> {
	const filename = await entryName(conversationId, contentSha, reader);
	const entry = await collections.blobStore.findOne("files", {
		filename,
		"metadata.conversation": conversationId,
	});
	if (!entry) return null;
	try {
		const parsed = JSON.parse(
			(await collections.blobStore.read("files", entry.id)).toString("utf-8")
		);
		if (
			!Array.isArray(parsed?.pages) ||
			!parsed.pages.every((p: unknown) => typeof p === "string")
		) {
			return null;
		}
		return parsed as CachedExtraction;
	} catch {
		return null;
	}
}

export async function putCachedExtraction(
	conversationId: string,
	contentSha: string,
	reader: string,
	value: CachedExtraction
): Promise<void> {
	await collections.blobStore.put(
		"files",
		{
			filename: await entryName(conversationId, contentSha, reader),
			metadata: {
				conversation: conversationId,
				mime: "application/json",
				extractCache: true,
				extractedFrom: contentSha,
				reader,
				pages: value.pages.length,
			},
		},
		Buffer.from(JSON.stringify(value), "utf-8")
	);
}
