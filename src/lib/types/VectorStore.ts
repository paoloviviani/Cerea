import type { ObjectId } from "bson";
import type { Timestamps } from "./Timestamps";

/**
 * A knowledge base, chat-side since ADR 0070.
 *
 * The geometry (chunk shape, embedding model) is copied onto the row at
 * creation rather than read at ingestion time, so a later change to the
 * deployment's defaults cannot silently re-chunk half of an existing base —
 * the same decision the gateway's version made, and for the same reason.
 */
export interface VectorStore extends Timestamps {
	_id: ObjectId;

	name: string;
	description?: string;
	ownerId: ObjectId;
	/** The gateway model the vectors come from, by catalogue name. */
	embeddingModel: string;
	/** How wide that model's vectors are; null until the first embedding. */
	dimensions: number | null;
	chunkChars: number;
	chunkOverlap: number;

	/** Who beyond the owner may reach this base, and how. */
	shares: VectorStoreShare[];
}

export interface VectorStoreShare {
	/** `user` shares name a chat user's email; `group` shares a gateway group. */
	kind: "user" | "group";
	/** The email, or the group name, exactly as it was shared. */
	principal: string;
	role: "viewer" | "editor";
}

/**
 * One indexed thing in a base: a passage with no file behind it (a
 * conversation transcript, pasted text) or an uploaded document.
 *
 * `text` keeps the extracted markdown so a reindex costs embeddings and no
 * re-extraction — `/v1/ocr` is priced per page, and re-reading the same
 * twelve-page PDF to re-embed it would be paying twice for one document.
 */
export interface KnowledgeDocument extends Timestamps {
	_id: ObjectId;

	storeId: ObjectId;
	/** The GridFS id of the uploaded bytes, when there is a file. */
	fileId?: ObjectId;
	filename?: string;
	title: string;
	/** Idempotency handle for text writes: re-posting replaces, never duplicates. */
	sourceRef?: string;
	text?: string;
	chars: number;
	chunkCount: number;
	status: "pending" | "ready" | "failed";
	error: string;
	/** The embedding model the CURRENT vectors were made with. */
	embeddingModel: string | null;
	indexedAt: Date | null;
}

/** The deployment's knowledge-pipeline configuration, admin-set in the chat. */
export interface KnowledgeConfig extends Timestamps {
	_id?: ObjectId;

	/** Off is the honest default: the pipeline needs an embedding model to be useful. */
	enabled: boolean;
	embeddingModel: string | null;
	/**
	 * Which model reads documents, as the Knowledge screen chose. `null` is the
	 * built-in extractor said *deliberately* — it never leaves this deployment —
	 * while `undefined` means the screen has never decided, and extraction falls
	 * back to `CHAT_OCR_MODEL` and then to the first OCR model the caller may
	 * use. The distinction is load-bearing: writing `null` for "not decided yet"
	 * would silently switch a deployment that configured extraction through the
	 * environment over to the built-in extractor the moment any other setting
	 * was saved.
	 */
	extractorModel?: string | null;
	chunkChars: number;
	chunkOverlap: number;
}

/**
 * One append-only record of a configuration change, for the "which model was
 * this base built with, and who moved the default" question that gets asked
 * long after the change. Reason is only ever attached to the change that
 * re-points extraction at a model — the one setting that alters where user
 * documents are sent.
 */
export interface KnowledgeConfigChange {
	_id?: ObjectId;
	embeddingModel: string | null;
	extractorModel: string | null;
	chunkChars: number;
	chunkOverlap: number;
	reason: string;
	changedBy: string | null;
	createdAt: Date;
}
