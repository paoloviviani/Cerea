/**
 * The knowledge pipeline's operations, chat-side (ADR 0070).
 *
 * Every function here returns objects in the shapes the browser's screens
 * already read (`VectorStore`, `KnowledgeDocument`, `KnowledgeStatus`), so the
 * screens did not move when the store did. The Mongo documents carry the
 * things a person names; the Postgres chunks carry only what a ranking query
 * reads.
 */
import { randomUUID } from "node:crypto";
import { ObjectId } from "bson";
import type { GridFSBucket } from "mongodb";

import { collections } from "$lib/server/database";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";
import { chunkMarkdown } from "./chunking";
import { INDEXED_DIMENSIONS, toUuid, withClient } from "./db";
import { fromUuid } from "./db";
import { embed } from "./embed";
import type { KnowledgeConfig, KnowledgeDocument, VectorStore } from "$lib/types/VectorStore";

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export class KnowledgeError extends Error {
	constructor(
		readonly status: number,
		message: string
	) {
		super(message);
		this.name = "KnowledgeError";
	}
}

const DEFAULT_CONFIG: Omit<KnowledgeConfig, "_id" | "createdAt" | "updatedAt"> = {
	enabled: false,
	embeddingModel: null,
	chunkChars: 1200,
	chunkOverlap: 150,
};

// -- configuration -----------------------------------------------------------

export async function readConfig(): Promise<KnowledgeConfig> {
	const row = await collections.knowledgeConfig.findOne({});
	return {
		...DEFAULT_CONFIG,
		...(row ?? {}),
		_id: (row?._id as ObjectId) ?? new ObjectId(),
		createdAt: row?.createdAt ?? new Date(),
		updatedAt: row?.updatedAt ?? new Date(),
	};
}

export async function writeConfig(patch: Partial<KnowledgeConfig>): Promise<KnowledgeConfig> {
	const current = await readConfig();
	const next: KnowledgeConfig = {
		...current,
		...patch,
		updatedAt: new Date(),
	};
	const id = new ObjectId(current._id as ObjectId);
	const saved = { ...next, _id: id };
	await collections.knowledgeConfig.replaceOne({ _id: id } as never, saved as never, {
		upsert: true,
	});
	return saved;
}

/** Is the pipeline usable: enabled, and an embedding model named? */
function configReady(config: KnowledgeConfig): boolean {
	return config.enabled && Boolean(config.embeddingModel);
}

// -- reach -------------------------------------------------------------------

export interface Caller {
	userId: ObjectId;
	email: string | null;
	/** The gateway's groups for this caller, from `/v1/me` (ADR 0069). */
	groups: string[];
	isAdmin: boolean;
}

/**
 * The caller, from the request's locals: the chat's own user for ownership,
 * the gateway's answer for the groups a share may name.
 */
export async function callerFrom(locals: App.Locals): Promise<Caller> {
	if (!locals.user) {
		throw new KnowledgeError(401, "Sign in to use knowledge bases.");
	}
	const { callerIdentity } = await import("$lib/server/admin");
	const identity = await callerIdentity(locals);
	return {
		userId: locals.user._id,
		email: locals.user.email ?? identity?.email ?? null,
		groups: identity?.groups ?? [],
		isAdmin: identity?.isAdmin === true,
	};
}

/** Reachable: owner, shared to this caller by email, or shared to one of their groups. */
function mayReach(base: VectorStore, caller: Caller, role: "viewer" | "editor"): boolean {
	if (base.ownerId.equals(caller.userId)) return true;
	return base.shares.some(
		(share) =>
			// A viewer share grants reading; an editor share grants both. An
			// edit through a viewer share is the 403 case, not this one.
			(role === "viewer" || share.role === "editor") &&
			((share.kind === "user" && share.principal === caller.email) ||
				(share.kind === "group" && caller.groups.includes(share.principal)))
	);
}

/** One base this caller may reach in `role`, or 404/403 in the HTTP sense. */
export async function reachableStore(
	storeId: string,
	caller: Caller,
	role: "viewer" | "editor" = "viewer"
): Promise<VectorStore> {
	let base: VectorStore | null = null;
	try {
		base = await collections.vectorStores.findOne({ _id: new ObjectId(storeId) });
	} catch {
		throw new KnowledgeError(404, `No such vector store: ${storeId}`);
	}
	if (!base) throw new KnowledgeError(404, `No such vector store: ${storeId}`);
	if (base.ownerId.equals(caller.userId)) return base;
	const share = base.shares.find(
		(s) =>
			(role === "viewer" || s.role === "editor") &&
			((s.kind === "user" && s.principal === caller.email) ||
				(s.kind === "group" && caller.groups.includes(s.principal)))
	);
	if (!share) throw new KnowledgeError(404, `No such vector store: ${storeId}`);
	if (role === "editor" && share.role !== "editor") {
		throw new KnowledgeError(403, "You have read-only access to this vector store.");
	}
	return base;
}

// -- shapes the screens read --------------------------------------------------

interface FileCounts {
	in_progress: number;
	completed: number;
	failed: number;
	total: number;
}

async function fileCounts(storeId: ObjectId): Promise<FileCounts> {
	const rows = await collections.knowledgeDocuments
		.aggregate<{ _id: string; count: number }>([
			{ $match: { storeId } },
			{ $group: { _id: "$status", count: { $sum: 1 } } },
		])
		.toArray();
	const counts = { in_progress: 0, completed: 0, failed: 0, total: 0 };
	for (const row of rows) {
		const n = row.count;
		counts.total += n;
		if (row._id === "ready") counts.completed += n;
		else if (row._id === "failed") counts.failed += n;
		else counts.in_progress += n;
	}
	return counts;
}

export async function storeObject(
	base: VectorStore,
	caller: Caller
): Promise<{
	id: string;
	created_at: number;
	name: string;
	description: string;
	file_counts: { in_progress: number; completed: number; failed: number; total: number };
	dimensions: number | null;
	embedding_model: string | null;
	owned: boolean;
	role: string;
}> {
	const owned = base.ownerId.equals(caller.userId);
	const share = base.shares.find(
		(s) =>
			(s.kind === "user" && s.principal === caller.email) ||
			(s.kind === "group" && caller.groups.includes(s.principal))
	);
	return {
		id: base._id.toString(),
		created_at: base.createdAt.getTime(),
		name: base.name,
		description: base.description ?? "",
		file_counts: await fileCounts(base._id),
		dimensions: base.dimensions ?? null,
		embedding_model: base.embeddingModel ?? null,
		owned,
		role: owned ? "owner" : (share?.role ?? "viewer"),
	};
}

function documentObject(
	document: KnowledgeDocument,
	filename: string | null
): {
	id: string;
	created_at: number;
	status: string;
	title: string;
	filename: string | null;
	file_id: string | null;
	source_ref: string | null;
	chunk_count: number;
	error: string | null;
} {
	return {
		id: document._id.toString(),
		created_at: document.createdAt.getTime(),
		status: document.status,
		title: document.title,
		filename: filename ?? document.filename ?? null,
		file_id: document.fileId?.toString() ?? null,
		source_ref: document.sourceRef ?? null,
		chunk_count: document.chunkCount,
		error: document.error || null,
	};
}

export async function statusObject(
	caller: Caller,
	token: string | undefined
): Promise<{
	enabled: boolean;
	ready: boolean;
	embedding_model: string | null;
	max_upload_bytes: number;
	detail: string | null;
}> {
	const config = await readConfig();
	let detail: string | null = null;
	if (config.enabled && !config.embeddingModel) {
		detail =
			"No embedding model has been chosen. An administrator sets one on the Knowledge screen.";
	} else if (config.embeddingModel && token) {
		// The model must exist in the caller's catalogue: a name the gateway
		// does not know would fail on first use, and saying so now is kinder.
		try {
			const models = await gateway.get<{ data: { id: string }[] }>(token, "models");
			const exists = models.data.some((m) => m.id === config.embeddingModel);
			if (!exists) {
				detail = `The configured embedding model “${config.embeddingModel}” is not in this deployment's catalogue.`;
			}
		} catch (err) {
			logger.warn({ err }, "knowledge_status_model_probe_failed");
		}
	}
	return {
		enabled: config.enabled,
		ready: configReady(config) && !detail,
		embedding_model: config.embeddingModel,
		max_upload_bytes: MAX_UPLOAD_BYTES,
		detail,
	};
}

// -- stores ------------------------------------------------------------------

export async function listStores(
	caller: Caller
): Promise<{ data: Awaited<ReturnType<typeof storeObject>>[] }> {
	const rows = await collections.vectorStores.find().sort({ createdAt: -1 }).toArray();
	const mine = rows.filter((base) => mayReach(base, caller, "viewer"));
	const objects = await Promise.all(mine.map((base) => storeObject(base, caller)));
	return { data: objects };
}

export async function createStore(
	caller: Caller,
	body: { name: string; description?: string }
): Promise<Awaited<ReturnType<typeof storeObject>>> {
	const config = await readConfig();
	if (!body.name?.trim()) throw new KnowledgeError(400, "A name is required.");
	// The geometry is copied onto the row, not read at ingestion time: a later
	// change to the deployment's defaults cannot re-chunk half of an existing
	// base (ADR 0070).
	const base: VectorStore = {
		_id: new ObjectId(),
		name: body.name.trim().slice(0, 200),
		description: body.description?.slice(0, 2000),
		ownerId: caller.userId,
		embeddingModel: config.embeddingModel ?? "",
		dimensions: null,
		chunkChars: config.chunkChars,
		chunkOverlap: config.chunkOverlap,
		shares: [],
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await collections.vectorStores.insertOne(base);
	return storeObject(base, caller);
}

export async function deleteStore(storeId: string, caller: Caller): Promise<void> {
	const base = await reachableStore(storeId, caller, "editor");
	if (!base.ownerId.equals(caller.userId)) {
		throw new KnowledgeError(403, "Only the owner can delete a vector store.");
	}
	await collections.knowledgeDocuments.deleteMany({ storeId: base._id });
	await collections.vectorStores.deleteOne({ _id: base._id });
	await withClient((client) =>
		client.query("DELETE FROM knowledge_chunks WHERE store_id = $1", [toUuid(base._id.toString())])
	);
}

// -- ingestion ---------------------------------------------------------------

async function embedChunks(token: string, base: VectorStore, texts: string[]): Promise<number[][]> {
	const model = base.embeddingModel;
	if (!model) {
		throw new KnowledgeError(400, "This base has no embedding model configured.");
	}
	// Batched: one call per document, in slices the gateway will accept.
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += 32) {
		out.push(...(await embed(token, model, texts.slice(i, i + 32))));
	}
	return out;
}

async function upsertChunks(
	storeId: ObjectId,
	documentId: ObjectId,
	chunks: { ordinal: number; text: string }[],
	vectors: number[][]
): Promise<void> {
	// First write in this process creates the tables and indexes.
	const { ensureSchema } = await import("./db");
	await ensureSchema();
	await withClient(async (client) => {
		await client.query("BEGIN");
		try {
			await client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [
				toUuid(documentId.toString()),
			]);
			for (let i = 0; i < chunks.length; i++) {
				const vector = vectors[i];
				const dims = vector.length;
				if (!INDEXED_DIMENSIONS.includes(dims as (typeof INDEXED_DIMENSIONS)[number])) {
					throw new KnowledgeError(
						400,
						`The embedding model returns ${dims} dimensions; this store indexes ${INDEXED_DIMENSIONS.join(", ")}.`
					);
				}
				await client.query(
					`INSERT INTO knowledge_chunks
						(store_id, document_id, ordinal, text, token_count, embedding, dimensions)
					 VALUES ($1, $2, $3, $4, $5, $6::vector, $7)`,
					[
						toUuid(storeId.toString()),
						toUuid(documentId.toString()),
						chunks[i].ordinal,
						chunks[i].text,
						Math.ceil(chunks[i].text.length / 4),
						`[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`,
						dims,
					]
				);
			}
			await client.query("COMMIT");
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		}
	});
}

/**
 * Index one document's text: chunk, embed, store.
 *
 * Synchronous by decision: this deployment's documents are small, and a
 * background worker with its own failure surface is not worth it for a
 * twelve-page PDF. The document's status row is the progress record either way.
 */
export async function ingestDocument(
	documentId: ObjectId,
	token: string
): Promise<KnowledgeDocument> {
	const document = await collections.knowledgeDocuments.findOne({ _id: documentId });
	if (!document) throw new KnowledgeError(404, "No such document.");
	const base = await collections.vectorStores.findOne({ _id: document.storeId });
	if (!base) throw new KnowledgeError(404, "No such vector store.");

	let text = document.text;
	if (text === undefined || text === null) {
		if (!document.fileId) {
			throw new KnowledgeError(400, "The document has no text and no file to read.");
		}
		// Re-read the stored bytes through the reading service. A reindex of a
		// file document whose text was lost re-pays the extraction; keeping the
		// text on the row is what makes the ordinary reindex cheap.
		const bytes = await readStoredFile(document.fileId);
		const { extractDocument, isExtractableDocument } =
			await import("$lib/server/files/extractDocument");
		const mime = await storedFileMime(document.fileId);
		if (!isExtractableDocument(mime)) {
			text = bytes.toString("utf-8");
		} else {
			const extracted = await extractDocument({
				bytes: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength
				) as ArrayBuffer,
				mime,
				filename: document.filename ?? "document",
				token,
			});
			if (!extracted) throw new KnowledgeError(502, "The document could not be read.");
			text = extracted.text;
		}
		await collections.knowledgeDocuments.updateOne(
			{ _id: document._id },
			{ $set: { text, chars: text.length, updatedAt: new Date() } }
		);
	}

	try {
		const chunks = chunkMarkdown(text, base.chunkChars, base.chunkOverlap);
		if (chunks.length === 0) {
			await collections.knowledgeDocuments.updateOne(
				{ _id: document._id },
				{
					$set: {
						status: "ready",
						chunkCount: 0,
						error: "",
						indexedAt: new Date(),
						embeddingModel: base.embeddingModel,
						updatedAt: new Date(),
					},
				}
			);
			const settled = await collections.knowledgeDocuments.findOne({ _id: document._id });
			if (!settled) throw new KnowledgeError(500, "The document vanished while indexing.");
			return settled;
		}
		const vectors = await embedChunks(
			token,
			base,
			chunks.map((chunk) => chunk.text)
		);
		await upsertChunks(base._id, document._id, chunks, vectors);
		if (base.dimensions === null || base.dimensions !== vectors[0].length) {
			await collections.vectorStores.updateOne(
				{ _id: base._id },
				{ $set: { dimensions: vectors[0].length, updatedAt: new Date() } }
			);
		}
		await collections.knowledgeDocuments.updateOne(
			{ _id: document._id },
			{
				$set: {
					status: "ready",
					chunkCount: chunks.length,
					error: "",
					indexedAt: new Date(),
					embeddingModel: base.embeddingModel,
					updatedAt: new Date(),
				},
			}
		);
	} catch (err) {
		const message =
			err instanceof GatewayCallFailed || err instanceof KnowledgeError
				? err.message
				: "Indexing failed.";
		logger.warn({ err, document: document._id.toString() }, "knowledge_ingest_failed");
		await collections.knowledgeDocuments.updateOne(
			{ _id: document._id },
			{ $set: { status: "failed", error: message, updatedAt: new Date() } }
		);
	}
	const finished = await collections.knowledgeDocuments.findOne({ _id: document._id });
	if (!finished) throw new KnowledgeError(500, "The document vanished while indexing.");
	return finished;
}

function bucket(): GridFSBucket {
	return collections.bucket;
}

async function readStoredFile(fileId: ObjectId): Promise<Buffer> {
	const chunks: Buffer[] = [];
	const stream = bucket().openDownloadStream(fileId);
	for await (const chunk of stream) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks);
}

async function storedFileMime(fileId: ObjectId): Promise<string> {
	const file = await bucket().find({ _id: fileId }).next();
	return (file?.metadata?.mime as string | undefined) ?? "application/octet-stream";
}

/**
 * Store an upload for indexing: bytes into the chat's own GridFS, metadata
 * beside them. Returns the handle the attach call takes.
 */
export async function storeUpload(
	file: { name: string; bytes: Buffer; mime: string },
	ownerId: ObjectId
): Promise<{ id: string; filename: string; bytes: number }> {
	if (file.bytes.length > MAX_UPLOAD_BYTES) {
		throw new KnowledgeError(
			413,
			`Files are limited to ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))} MB.`
		);
	}
	const id = new ObjectId();
	return new Promise((resolve, reject) => {
		const upload = bucket().openUploadStreamWithId(id, file.name, {
			metadata: { mime: file.mime, owner: ownerId.toString() },
		});
		upload.write(file.bytes);
		upload.end();
		upload.once("finish", () =>
			resolve({ id: id.toString(), filename: file.name, bytes: file.bytes.length })
		);
		upload.once("error", reject);
		setTimeout(() => reject(new KnowledgeError(504, "Upload timed out")), 60_000);
	});
}

/** Delete an upload that was never attached, or no longer needed. */
export async function deleteUpload(fileId: string, caller: Caller): Promise<void> {
	const file = await bucket()
		.find({ _id: new ObjectId(fileId) })
		.next();
	if (!file) throw new KnowledgeError(404, `No such file: ${fileId}`);
	if (file.metadata?.owner !== caller.userId.toString()) {
		throw new KnowledgeError(404, `No such file: ${fileId}`);
	}
	await bucket().delete(new ObjectId(fileId));
}

// -- the API surface ----------------------------------------------------------

export async function attachFile(
	storeId: string,
	caller: Caller,
	token: string,
	body: { file_id: string; title?: string }
): Promise<ReturnType<typeof documentObject>> {
	const base = await reachableStore(storeId, caller, "editor");
	const config = await readConfig();
	if (!configReady(config)) {
		throw new KnowledgeError(
			400,
			"No embedding model has been configured for this deployment, so documents cannot be indexed yet."
		);
	}
	const fileId = new ObjectId(body.file_id);
	const stored = await bucket().find({ _id: fileId }).next();
	// A file belongs to one person: indexing somebody else's upload into a
	// base you happen to be able to edit would read their document through
	// search.
	if (!stored || stored.metadata?.owner !== caller.userId.toString()) {
		throw new KnowledgeError(404, `No such file: ${body.file_id}`);
	}
	const document: KnowledgeDocument = {
		_id: new ObjectId(),
		storeId: base._id,
		fileId,
		filename: stored.filename ?? body.title ?? "document",
		title: body.title || stored.filename || "document",
		chars: 0,
		chunkCount: 0,
		status: "pending",
		error: "",
		embeddingModel: null,
		indexedAt: null,
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await collections.knowledgeDocuments.insertOne(document);
	const ingested = await ingestDocument(document._id, token);
	return documentObject(ingested, stored.filename ?? null);
}

export async function addText(
	storeId: string,
	caller: Caller,
	token: string,
	body: { text: string; title?: string; source_ref?: string }
): Promise<ReturnType<typeof documentObject>> {
	const base = await reachableStore(storeId, caller, "editor");
	const config = await readConfig();
	if (!configReady(config)) {
		throw new KnowledgeError(
			400,
			"No embedding model has been configured, so text cannot be indexed yet."
		);
	}
	let document = body.source_ref
		? await collections.knowledgeDocuments.findOne({
				storeId: base._id,
				sourceRef: body.source_ref,
			})
		: null;

	if (!document) {
		document = {
			_id: new ObjectId(),
			storeId: base._id,
			sourceRef: body.source_ref,
			title: body.title || body.source_ref || "text",
			chars: body.text.length,
			chunkCount: 0,
			status: "pending",
			error: "",
			embeddingModel: null,
			indexedAt: null,
			createdAt: new Date(),
			updatedAt: new Date(),
		} satisfies KnowledgeDocument;
		await collections.knowledgeDocuments.insertOne(document);
	} else if (document) {
		// Replacing: the old chunks go now, so a search landing mid-reindex
		// cannot return passages from the previous version alongside the new.
		const existing = document;
		await withClient((client) =>
			client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [
				toUuid(existing._id.toString()),
			])
		);
		document.title = body.title || document.title;
	}
	await collections.knowledgeDocuments.updateOne(
		{ _id: document._id },
		{
			$set: {
				text: body.text,
				chars: body.text.length,
				title: body.title || document.title,
				status: "pending",
				error: "",
				indexedAt: null,
				updatedAt: new Date(),
			},
		}
	);
	const ingested = await ingestDocument(document._id, token);
	return documentObject(ingested, null);
}

export async function listDocuments(
	storeId: string,
	caller: Caller
): Promise<{ data: ReturnType<typeof documentObject>[] }> {
	const base = await reachableStore(storeId, caller);
	const rows = await collections.knowledgeDocuments
		.find({ storeId: base._id })
		.sort({ createdAt: -1 })
		.toArray();
	return { data: rows.map((row) => documentObject(row, null)) };
}

export async function deleteDocument(
	storeId: string,
	documentId: string,
	caller: Caller
): Promise<void> {
	await reachableStore(storeId, caller, "editor");
	await collections.knowledgeDocuments.deleteOne({
		_id: new ObjectId(documentId),
		storeId: new ObjectId(storeId),
	});
	await withClient((client) =>
		client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [toUuid(documentId)])
	);
}

export async function search(
	storeId: string,
	caller: Caller,
	token: string,
	body: { query: string; max_num_results?: number; min_score?: number }
): Promise<{
	search_query: string;
	data: {
		document_id: string;
		chunk_id: string;
		ordinal: number;
		score: number;
		text: string;
		title: string | null;
		source_ref: string | null;
	}[];
}> {
	const base = await reachableStore(storeId, caller);
	if (base.dimensions === null || !base.embeddingModel) {
		// Not an error: a base with nothing indexed has no vectors to compare.
		return { search_query: body.query, data: [] };
	}
	const limit = body.max_num_results ?? 8;
	const floor = body.min_score ?? 0;
	// The query embeds with the reader's token: the chat holds no other
	// credential, and a search charged to whoever asks is visible in the
	// ledger and cannot be a hidden cost on a shared base's owner.
	try {
		const [vector] = await embedChunks(token, base, [body.query]);
		const dims = base.dimensions;
		const literal = `[${vector.map((v) => (Number.isFinite(v) ? v : 0)).join(",")}]`;
		if (!INDEXED_DIMENSIONS.includes(dims as (typeof INDEXED_DIMENSIONS)[number])) {
			throw new KnowledgeError(400, `This base's vectors are ${dims} wide; no index covers that.`);
		}
		const hits = await withClient(async (client) => {
			const { ensureSchema } = await import("./db");
			await ensureSchema();
			const result = await client.query(
				`SELECT c.id AS chunk_id, c.document_id AS document_id, c.ordinal, c.text,
					1 - (c.embedding::halfvec(${dims}) <=> ($3::vector)::halfvec(${dims})) AS score
				 FROM knowledge_chunks c
				 WHERE c.store_id = $1 AND c.dimensions = $2
				 ORDER BY c.embedding::halfvec(${dims}) <=> ($3::vector)::halfvec(${dims})
				 LIMIT $4`,
				[toUuid(base._id.toString()), dims, literal, limit]
			);
			return result.rows as {
				chunk_id: string;
				document_id: string;
				ordinal: number;
				text: string;
				score: number;
			}[];
		});
		const titles = await collections.knowledgeDocuments
			.find({ _id: { $in: hits.map((h) => new ObjectId(fromUuid(h.document_id))) } })
			.toArray();
		// The store hands uuids back; the documents are keyed by their Mongo
		// ids, which is the first 24 hex of that uuid.
		const byId = new Map(titles.map((row) => [row._id.toString(), row]));
		return {
			search_query: body.query,
			data: hits
				.filter((hit) => hit.score >= floor)
				.map((hit) => {
					const documentId = fromUuid(hit.document_id);
					const document = byId.get(documentId);
					return {
						document_id: documentId,
						chunk_id: fromUuid(hit.chunk_id),
						ordinal: hit.ordinal,
						score: hit.score,
						text: hit.text,
						title: document?.title ?? null,
						source_ref: document?.sourceRef ?? null,
					};
				}),
		};
	} catch (err) {
		if (err instanceof GatewayCallFailed) {
			throw new KnowledgeError(502, `Search is unavailable: ${err.message}`);
		}
		throw err;
	}
}

export async function reindex(
	storeId: string,
	caller: Caller,
	token: string
): Promise<{ data: ReturnType<typeof documentObject>[] }> {
	const base = await reachableStore(storeId, caller, "editor");
	if (!base.ownerId.equals(caller.userId)) {
		throw new KnowledgeError(403, "Only the owner can reindex a vector store.");
	}
	const config = await readConfig();
	if (!configReady(config)) {
		throw new KnowledgeError(400, "No embedding model has been configured.");
	}
	// The base moves to the deployment's current model — the one place that
	// changes it, so a base's model only ever changes as a deliberate act.
	await collections.vectorStores.updateOne(
		{ _id: base._id },
		{
			$set: {
				embeddingModel: config.embeddingModel ?? "",
				dimensions: null,
				updatedAt: new Date(),
			},
		}
	);
	const rows = await collections.knowledgeDocuments
		.find({
			storeId: base._id,
			$or: [{ text: { $exists: true, $type: "string" } }, { fileId: { $exists: true } }],
		})
		.toArray();
	await collections.knowledgeDocuments.updateMany(
		{ _id: { $in: rows.map((row) => row._id) } },
		{
			$set: { status: "pending", error: "", indexedAt: null, updatedAt: new Date() },
		}
	);
	const out: ReturnType<typeof documentObject>[] = [];
	for (const row of rows) {
		out.push(documentObject(await ingestDocument(row._id, token), null));
	}
	return { data: out };
}

// -- shares -------------------------------------------------------------------

export async function listShares(
	storeId: string,
	caller: Caller
): Promise<{ data: { principal_kind: "user" | "group"; principal_id: string; role: string }[] }> {
	const base = await reachableStore(storeId, caller);
	if (!base.ownerId.equals(caller.userId)) {
		throw new KnowledgeError(404, `No such vector store: ${storeId}`);
	}
	return {
		data: base.shares.map((share) => ({
			principal_kind: share.kind,
			principal_id: share.principal,
			role: share.role,
		})),
	};
}

export async function addShare(
	storeId: string,
	caller: Caller,
	body: {
		principal_kind: "user" | "group";
		principal_email?: string;
		group_name?: string;
		role?: "viewer" | "editor";
	}
): Promise<void> {
	const base = await reachableStore(storeId, caller);
	if (!base.ownerId.equals(caller.userId)) {
		throw new KnowledgeError(403, "Only the owner can share a vector store.");
	}
	const principal =
		body.principal_kind === "user" ? body.principal_email?.trim() : body.group_name?.trim();
	if (!principal) throw new KnowledgeError(400, "A recipient is required.");
	if (body.principal_kind === "user") {
		// Resolved against the chat's own users, now — a share to nobody is
		// refused, not stored as a silent no-op.
		const user = await collections.users.findOne({ email: principal });
		if (!user) throw new KnowledgeError(404, `No such user: ${principal}`);
	}
	const role = body.role ?? "viewer";
	const shares = base.shares.filter(
		(share) => !(share.kind === body.principal_kind && share.principal === principal)
	);
	shares.push({ kind: body.principal_kind, principal, role });
	await collections.vectorStores.updateOne(
		{ _id: base._id },
		{ $set: { shares, updatedAt: new Date() } }
	);
}

export function newDocumentId(): string {
	return randomUUID();
}

/** The name the generation-side retrievers call. */
export { search as searchBase };
