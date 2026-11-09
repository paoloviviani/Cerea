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
	/**
	 * True when the owner chose `embeddingModel` for this base, rather than it
	 * following the deployment's default. A chosen model is never "stale": the
	 * admin's default moving does not strand it, and a plain reindex keeps it.
	 */
	embeddingChosen?: boolean;
	/**
	 * Bumped by every reindex. An ingest that read the base before a reindex
	 * moved it drops its write when the number has changed, so vectors of the
	 * old model never land beside the new model's.
	 */
	embeddingGeneration?: number;
	/** Set while a reindex is running; the claim that keeps a second one out. */
	reindexingSince?: Date | null;
	/**
	 * The passage prefix the vectors were made with, recorded with the model:
	 * a different one makes them stale, as a different model does. Absent on
	 * older bases, which means empty.
	 */
	passagePrefix?: string;
	/** The query prefix in force when the base was indexed; used for searches
	 * while the base is still on a model other than the current one. */
	queryPrefix?: string;
	/**
	 * The document reader (a gateway OCR model) this base's uploads are read
	 * with, as its owner chose. Absent means the deployment's default reader.
	 * Changing it applies to new uploads only.
	 */
	readerModel?: string;
	/** `readerModel` is a local reader: its documents stay in this deployment. */
	readerLocal?: boolean;
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
	/** The reader that read the original (a gateway model id), when recorded. */
	readerModel?: string;
	/** The chosen reader was unavailable to the user, so the default read it. */
	readerFallback?: boolean;
}

/** The deployment's knowledge-pipeline configuration, admin-set in the chat. */
export interface KnowledgeConfig extends Timestamps {
	_id?: ObjectId;

	/** Off is the honest default: the pipeline needs an embedding model to be useful. */
	enabled: boolean;
	embeddingModel: string | null;
	/** Prefix for a text indexed for search (e5 `passage: `); empty by default. */
	passagePrefix?: string;
	/** Prefix for a search input (e5 `query: `); empty by default. */
	queryPrefix?: string;
	/**
	 * Which model reads documents, as the Knowledge screen chose. Only a
	 * non-empty string is a choice: `null` (the screen's "Automatic" option)
	 * and an absent field both mean the deployment default — `CHAT_OCR_MODEL`,
	 * then the first reader in the catalogue the caller may use. There is
	 * deliberately no value meaning "read nothing": one existed, and a
	 * deployment that chose it extracted no documents while being told the
	 * opposite. The deployment's own reader is an ordinary model in the
	 * catalogue — its provider is the local extractor service — so naming it
	 * and naming any other reader are the same act.
	 */
	extractorModel?: string | null;
	/**
	 * The search backend (a gateway model name) web search runs on, as the Web
	 * search admin screen chose. Not a knowledge setting — it lives in this
	 * document so web search stays configurable with the pipeline switched off.
	 * `null` or absent means the caller's billing-group search policy decides.
	 */
	webSearchModel?: string | null;
	/**
	 * Legacy home of the transcription model choice, from the one release that
	 * kept it here. Read only, when `voiceConfig` holds no choice; the Voice &
	 * audio screen writes `voiceConfig` and unsets this.
	 */
	transcriptionModel?: string | null;
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
	passagePrefix?: string;
	queryPrefix?: string;
	extractorModel: string | null;
	chunkChars: number;
	chunkOverlap: number;
	reason: string;
	changedBy: string | null;
	createdAt: Date;
}
