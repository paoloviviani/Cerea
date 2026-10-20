import type { ObjectId } from "mongodb";
import type { Conversation } from "./Conversation";

/**
 * The text `web_fetch` read out of one URL, kept for the conversation so a
 * later turn that asks for "page 40" or "continue from offset 48000" does not
 * download and extract (and, for a scanned PDF, pay for) the document again.
 *
 * Owned by the conversation, and so by its owner: the key is the conversation,
 * the owner and the canonical URL, so two people fetching one URL hold two
 * entries and a page read behind someone's login never reaches anyone else.
 * The text is stored inline in the row rather than in GridFS: it is capped
 * well under Mongo's 16 MB document limit, and one row means one delete
 * removes it, the native TTL index expires it, and there are no chunks to
 * orphan. Deleted with the conversation and by account erasure.
 */
export interface WebFetchCacheEntry {
	_id: ObjectId;
	conversationId: Conversation["_id"];
	/** Absent for an anonymous session; the conversation alone owns the row then. */
	userId?: ObjectId;
	/** The canonical URL the model asked for: the lookup key. */
	url: string;
	/** The page's own final URL after redirects, canonicalized. */
	finalUrl: string;
	title: string | null;
	text: string;
	/** UTF-8 size of `text`, for the per-conversation cap. */
	textBytes: number;
	/** sha256 (hex) of the fetched bytes: a changed document is extracted again. */
	contentHash: string;
	contentType: string;
	/** `html`: readable text from a page; `document`: read by `extractDocument` (local reader or OCR). */
	extractedBy: "html" | "document";
	/** When the bytes were last downloaded (a hash-matched re-download refreshes it). */
	fetchedAt: Date;
	/** When the text was last extracted. */
	extractedAt: Date;
	/** The TTL index removes the row at this time. */
	expiresAt: Date;
}
