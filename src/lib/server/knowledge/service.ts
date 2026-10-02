/**
 * The knowledge pipeline's operations, chat-side (ADR 0070).
 *
 * Every function here returns objects in the shapes the browser's screens
 * already read (`VectorStore`, `KnowledgeDocument`, `KnowledgeStatus`), so the
 * screens did not move when the store did. The Mongo documents carry the
 * things a person names; the Postgres chunks carry only what a ranking query
 * reads.
 */
import { createHash, randomUUID } from "node:crypto";
import { ObjectId } from "bson";
import type { GridFSBucket } from "mongodb";

import { collections } from "$lib/server/database";
import { config } from "$lib/server/config";
import { gateway, GatewayCallFailed } from "$lib/server/gatewayServer";
import { logger } from "$lib/server/logger";
import { chunkMarkdown } from "./chunking";
import { INDEXED_DIMENSIONS, toUuid, withClient } from "./db";
import { fromUuid } from "./db";
import { deleteDerived } from "./deleteDerived";
import { embed } from "./embed";
import {
	resolveExtractor,
	type ExtractorCandidate,
	type ExtractorSource,
} from "./extractorResolution";
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

export async function writeConfig(
	patch: Partial<KnowledgeConfig>,
	meta: { changedBy?: string | null; reason?: string } = {}
): Promise<KnowledgeConfig> {
	const current = await readConfig();
	const next: KnowledgeConfig = {
		...current,
		...patch,
		updatedAt: new Date(),
	};
	// Overlap never exceeds a third of the passage: past that, the same words
	// sit in enough neighbouring passages that a search returns one passage
	// three times over. Capped here rather than only at base creation, so the
	// geometry the screen shows is the geometry a new base will copy.
	next.chunkOverlap = Math.min(next.chunkOverlap, Math.floor(next.chunkChars / 3));

	const id = new ObjectId(current._id as ObjectId);
	const saved = { ...next, _id: id };
	await collections.knowledgeConfig.replaceOne({ _id: id } as never, saved as never, {
		upsert: true,
	});

	const changed =
		saved.enabled !== current.enabled ||
		saved.embeddingModel !== current.embeddingModel ||
		saved.extractorModel !== current.extractorModel ||
		saved.chunkChars !== current.chunkChars ||
		saved.chunkOverlap !== current.chunkOverlap;
	if (changed) {
		// Append-only, and only when something actually moved: the screen shows
		// this as the audit trail of decisions, and a no-op save is not one.
		await collections.knowledgeConfigHistory.insertOne({
			embeddingModel: saved.embeddingModel ?? null,
			extractorModel: saved.extractorModel ?? null,
			chunkChars: saved.chunkChars,
			chunkOverlap: saved.chunkOverlap,
			reason: meta.reason ?? "",
			changedBy: meta.changedBy ?? null,
			createdAt: new Date(),
		});
	}
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

/**
 * Every base in `storeIds` this caller may reach, in the order given, or a
 * 404 naming the first one that is missing or out of reach.
 *
 * One query rather than one per id: this runs on attach, where a body may
 * carry up to twenty ids, and the answer it needs is all-or-nothing — the
 * same rule `reachableStore` applies to a single id, applied to the batch.
 */
export async function reachableStores(storeIds: string[], caller: Caller): Promise<VectorStore[]> {
	const ids = storeIds.map((id) => {
		if (!/^[0-9a-f]{24}$/.test(id)) {
			throw new KnowledgeError(404, `No such vector store: ${id}`);
		}
		return new ObjectId(id);
	});
	const rows = await collections.vectorStores.find({ _id: { $in: ids } }).toArray();
	const byId = new Map(rows.map((base) => [base._id.toString(), base]));
	for (const id of storeIds) {
		const base = byId.get(id);
		if (!base || !mayReach(base, caller, "viewer")) {
			throw new KnowledgeError(404, `No such vector store: ${id}`);
		}
	}
	return storeIds.map((id) => byId.get(id) as VectorStore);
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

// -- the administration screen ------------------------------------------------

/**
 * The whole of what the admin Knowledge screen renders, in the shape its page
 * reads (ADR 0070). `statusObject` above answers the *user-facing* Knowledge
 * screen and stops at the pipeline's own readiness; this one adds the things
 * only an administrator decides or needs to see: the catalogue's embedding
 * and OCR models to choose among, every base in the deployment (not just the
 * caller's), which of those are stranded on an older embedding model, and the
 * append-only history of configuration changes.
 *
 * The screen renders `status.bases.length`, `status.available_embedding_models.length`
 * and friends unguarded, so every field here is part of a contract with the
 * page: a missing one is not a smaller answer, it is a TypeError that leaves
 * the screen on "Loading…" forever — which is exactly what a partial object
 * produced before this shape was written.
 */
export async function adminStatus(token: string | undefined): Promise<{
	enabled: boolean;
	ready: boolean;
	embedding_model: string | null;
	extractor_model: string | null;
	/** Why `extractor_model` is what it is: `"env"` and the picker is fixed
	 * and read-only; `"stored"` an administrator's own choice; the other two
	 * are what "nothing chosen" resolved to. */
	extractor_source: ExtractorSource;
	vector_store: string;
	chunk_chars: number;
	chunk_overlap: number;
	max_upload_bytes: number;
	source: string;
	propagation_seconds: number;
	detail: string | null;
	available_embedding_models: string[];
	available_extractor_models: ExtractorCandidate[];
	bases: {
		id: string;
		name: string;
		description: string;
		owner_email: string | null;
		group_name: string | null;
		embedding_model: string | null;
		dimensions: number | null;
		document_count: number;
		chunk_count: number;
		failed_count: number;
		stale: boolean;
		share_count: number;
		created_at: number;
	}[];
	stale_base_count: number;
	history: {
		id: string;
		embedding_model: string | null;
		extractor_model: string | null;
		chunk_chars: number;
		chunk_overlap: number;
		reason: string;
		changed_by: string | null;
		created_at: number;
	}[];
}> {
	const pipeline = await readConfig();

	// One catalogue fetch answers both "which models may be chosen" and the
	// readiness probe. `include=ocr` alongside the ordinary kinds is what
	// surfaces this deployment's own local extractor (Pystino's `?include=ocr`,
	// hidden from a plain `GET /v1/models`) with its `local` flag, so the
	// picker below can pre-select it. Without a token (no OIDC session behind
	// this request) the lists are empty and the screen says so in its own
	// words — better than refusing to render what is still true.
	let detail: string | null = null;
	let embeddingModels: string[] = [];
	let extractorCandidates: ExtractorCandidate[] = [];
	if (pipeline.enabled && !pipeline.embeddingModel) {
		detail =
			"No embedding model has been chosen. An administrator sets one on the Knowledge screen.";
	} else if (token) {
		try {
			const models = await gateway.get<{
				data: { id: string; kind?: string; local?: boolean }[];
			}>(token, "models?include=chat,embedding,image,ocr");
			const ids = models.data.map((model) => model.id);
			embeddingModels = models.data
				.filter((model) => model.kind === "embedding")
				.map((model) => model.id);
			extractorCandidates = models.data
				.filter((model) => model.kind === "ocr")
				.map((model) => ({ id: model.id, local: model.local === true }));
			if (pipeline.embeddingModel && !ids.includes(pipeline.embeddingModel)) {
				detail = `The configured embedding model “${pipeline.embeddingModel}” is not in this deployment's catalogue.`;
			}
		} catch (err) {
			logger.warn({ err }, "knowledge_status_model_probe_failed");
		}
	}

	const envExtractorModel = config.CHAT_OCR_MODEL?.trim() || null;
	const extractorResolution = resolveExtractor({
		envModel: envExtractorModel,
		storedModel: pipeline.extractorModel?.trim() || null,
		candidates: extractorCandidates,
	});

	// Every base, not the caller's: this is the deployment's administrator
	// looking at the deployment's pipeline. One aggregate over the documents
	// and one lookup over the owners, rather than a query per base.
	const rows = await collections.vectorStores.find().sort({ createdAt: -1 }).toArray();
	const ownerIds = [...new Set(rows.map((row) => row.ownerId))];
	const owners = ownerIds.length
		? await collections.users.find({ _id: { $in: ownerIds } }).toArray()
		: [];
	const ownerEmail = new Map(owners.map((owner) => [owner._id.toString(), owner.email]));
	const counts = await collections.knowledgeDocuments
		.aggregate<{ _id: ObjectId; documents: number; chunks: number; failed: number }>([
			{
				$group: {
					_id: "$storeId",
					documents: { $sum: 1 },
					chunks: { $sum: "$chunkCount" },
					failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } },
				},
			},
		])
		.toArray();
	const byStore = new Map(counts.map((row) => [row._id.toString(), row]));

	const bases = rows.map((base) => {
		const row = byStore.get(base._id.toString());
		// A base with nothing indexed is not stale: it has no vectors to be
		// comparable with the current model, and calling it stale would send
		// somebody to re-embed an empty base.
		const stale =
			base.dimensions !== null && (base.embeddingModel || null) !== pipeline.embeddingModel;
		return {
			id: base._id.toString(),
			name: base.name,
			description: base.description ?? "",
			owner_email: ownerEmail.get(base.ownerId.toString()) ?? null,
			group_name: null,
			embedding_model: base.embeddingModel || null,
			dimensions: base.dimensions ?? null,
			document_count: row?.documents ?? 0,
			chunk_count: row?.chunks ?? 0,
			failed_count: row?.failed ?? 0,
			stale,
			share_count: base.shares.length,
			created_at: base.createdAt.getTime(),
		};
	});

	const history = (
		await collections.knowledgeConfigHistory.find().sort({ createdAt: -1 }).limit(20).toArray()
	).map((entry) => ({
		id: (entry._id ?? new ObjectId()).toString(),
		embedding_model: entry.embeddingModel ?? null,
		extractor_model: entry.extractorModel ?? null,
		chunk_chars: entry.chunkChars,
		chunk_overlap: entry.chunkOverlap,
		reason: entry.reason || "",
		changed_by: entry.changedBy ?? null,
		created_at: entry.createdAt.getTime(),
	}));

	return {
		enabled: pipeline.enabled,
		ready: configReady(pipeline) && !detail,
		embedding_model: pipeline.embeddingModel,
		// What extraction will actually use — env, then the stored choice, then
		// this deployment's own local extractor, then the first reader, then
		// none (`resolveExtractor`) — so the screen never shows a reader that
		// is not what an upload would actually be sent to.
		extractor_model: extractorResolution.model,
		extractor_source: extractorResolution.source,
		vector_store: "pgvector — this deployment's own Postgres (ADR 0070)",
		chunk_chars: pipeline.chunkChars,
		chunk_overlap: pipeline.chunkOverlap,
		max_upload_bytes: MAX_UPLOAD_BYTES,
		// The row is Mongo, read per request: no cache, no propagation delay.
		source: "console",
		propagation_seconds: 0,
		detail,
		available_embedding_models: embeddingModels,
		available_extractor_models: extractorCandidates,
		bases,
		stale_base_count: bases.filter((base) => base.stale).length,
		history,
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
	await deleteDerived({ storeIds: base._id, dropStores: true });
}

// -- ingestion ---------------------------------------------------------------

async function embedChunks(token: string, base: VectorStore, texts: string[]): Promise<number[][]> {
	const model = base.embeddingModel;
	if (!model) {
		throw new KnowledgeError(400, "This base has no embedding model configured.");
	}
	// Batched: one call per document, in slices the gateway will accept. A base
	// that has indexed before knows its width — every embed for it asks for
	// exactly that, so a query vector and the stored ones are comparable.
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += 32) {
		out.push(...(await embed(token, model, texts.slice(i, i + 32), base.dimensions ?? undefined)));
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
			// One writer per document at a time: under READ COMMITTED a second
			// transaction's delete cannot see the first's uncommitted inserts, so
			// two concurrent indexings would each leave a full set of chunks. Held
			// until commit, the second waits and then deletes the first's.
			await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
				toUuid(documentId.toString()),
			]);
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

	// Everything from here can fail, and every failure lands on the row: the
	// reading phase used to sit outside this try, so a document whose text
	// could not be extracted stayed `pending` forever — shown as in-progress,
	// polled forever, with the reason nowhere. Failed is a state, not a throw;
	// the caller gets the row either way and the list says what happened.
	try {
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
				// The reason travels verbatim: "no reader configured" and "this is
				// a scan" are different problems with different fixes, and the row
				// is the one place the person asking can see either.
				if (!extracted.ok) throw new KnowledgeError(extracted.status, extracted.reason);
				text = extracted.text;
			}
			await collections.knowledgeDocuments.updateOne(
				{ _id: document._id },
				{ $set: { text, chars: text.length, updatedAt: new Date() } }
			);
		}

		const chunks = chunkMarkdown(text, base.chunkChars, base.chunkOverlap);
		if (chunks.length === 0) {
			// Nothing to keep, and the old passages must not outlive the text
			// they came from: the replace happens in the same transaction as
			// every other one, with no rows to write.
			await upsertChunks(base._id, document._id, [], []);
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
		let vectors = await embedChunks(
			token,
			base,
			chunks.map((chunk) => chunk.text)
		);
		// A model can speak wider than the store can index — this deployment's
		// qwen3-embedding-8b answers 4096, and no partial index covers that
		// (halfvec stops at 4000). MRL models accept a `dimensions` parameter
		// and truncate; asking for the largest width the schema covers below
		// the model's native keeps the base on the same index as every other,
		// and the base's recorded width is what every later embed — search
		// included — asks for. A model without MRL refuses the parameter and
		// the refusal lands on the row, which is the honest answer.
		const width = vectors[0]?.length ?? 0;
		if (!INDEXED_DIMENSIONS.includes(width as (typeof INDEXED_DIMENSIONS)[number])) {
			const target = Math.max(...INDEXED_DIMENSIONS.filter((d) => d < width));
			if (!target) {
				throw new KnowledgeError(
					400,
					`The embedding model returns ${width} dimensions; this store indexes ${INDEXED_DIMENSIONS.join(", ")}.`
				);
			}
			logger.info(
				{ base: base._id.toString(), native: width, truncatedTo: target },
				"knowledge_embedding_truncated: the model speaks wider than the store indexes"
			);
			base.dimensions = target;
			await collections.vectorStores.updateOne(
				{ _id: base._id },
				{ $set: { dimensions: target, updatedAt: new Date() } }
			);
			vectors = await embedChunks(
				token,
				base,
				chunks.map((chunk) => chunk.text)
			);
		}
		await upsertChunks(base._id, document._id, chunks, vectors);
		// The source may have been deleted while it was being embedded (a
		// conversation deleted mid-index, a base dropped mid-reindex). The
		// delete found no chunks to remove, and these would outlive it.
		if (
			!(await collections.knowledgeDocuments.findOne(
				{ _id: document._id },
				{ projection: { _id: 1 } }
			))
		) {
			await withClient((client) =>
				client.query("DELETE FROM knowledge_chunks WHERE document_id = $1", [
					toUuid(document._id.toString()),
				])
			);
			throw new KnowledgeError(404, "The document was deleted while it was being indexed.");
		}
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
			// The digest is what attachFile compares to tell a re-upload of the
			// same file from a new one.
			metadata: {
				mime: file.mime,
				owner: ownerId.toString(),
				sha256: createHash("sha256").update(file.bytes).digest("hex"),
			},
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
	// The same gate, for the reading half: a file that cannot be read cannot
	// be indexed, and refusing before the row exists keeps the failure out of
	// the list of half-made things. The reader resolves from the same places
	// extraction will look, so passing here means the ingest below has one.
	const { NO_READER_MESSAGE, resolveExtractorModel } =
		await import("$lib/server/files/extractDocument");
	if (!(await resolveExtractorModel(token))) {
		throw new KnowledgeError(503, NO_READER_MESSAGE);
	}
	const fileId = new ObjectId(body.file_id);
	const stored = await bucket().find({ _id: fileId }).next();
	// A file belongs to one person: indexing somebody else's upload into a
	// base you happen to be able to edit would read their document through
	// search.
	if (!stored || stored.metadata?.owner !== caller.userId.toString()) {
		throw new KnowledgeError(404, `No such file: ${body.file_id}`);
	}
	// The same file again is the same document: a second upload of identical
	// bytes into one base would index every passage twice and make every
	// search return both copies. A twin that failed is tried again, so a
	// retry is still a retry.
	const sha = stored.metadata?.sha256 as string | undefined;
	const inStore = await collections.knowledgeDocuments
		.find({ storeId: base._id, fileId: { $exists: true } })
		.toArray();
	const sameBytes = sha
		? new Set(
				(
					await collections.bucketFiles
						.find({
							_id: { $in: inStore.flatMap((d) => (d.fileId ? [d.fileId] : [])) },
							"metadata.sha256": sha,
						})
						.project<{ _id: ObjectId }>({ _id: 1 })
						.toArray()
				).map((f) => f._id.toString())
			)
		: new Set<string>();
	const twin = inStore.find(
		(d) => d.fileId?.equals(fileId) || sameBytes.has(d.fileId?.toString() ?? "")
	);
	if (twin) {
		if (!twin.fileId?.equals(fileId)) {
			await bucket()
				.delete(fileId)
				.catch(() => undefined);
		}
		const settled = twin.status === "failed" ? await ingestDocument(twin._id, token) : twin;
		return documentObject(settled, null);
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
		const fresh = {
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
		try {
			await collections.knowledgeDocuments.insertOne(fresh);
			document = fresh;
		} catch (err) {
			// Two turns of one conversation can both find nothing and both insert;
			// the unique (storeId, sourceRef) index refuses the second, which then
			// replaces the first's document like any later turn would.
			if (!body.source_ref || (err as { code?: number }).code !== 11000) throw err;
			document = await collections.knowledgeDocuments.findOne({
				storeId: base._id,
				sourceRef: body.source_ref,
			});
			if (!document) throw err;
		}
	}
	// Replacing needs no delete here: the old chunks stay searchable until the
	// new ones commit, and `upsertChunks` swaps them in one transaction. A
	// delete up front would make an embedding failure cost the whole memory.
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

/**
 * Put a failure on the document list, where a failed file would show: the row
 * for `sourceRef`, marked `failed` with the reason. For the failures that never
 * reach `ingestDocument` (which records its own). Best effort — this runs in a
 * catch, and a failure to report a failure is only logged.
 */
export async function markIndexFailed(
	storeId: ObjectId,
	sourceRef: string,
	title: string,
	message: string
): Promise<void> {
	try {
		await collections.knowledgeDocuments.updateOne(
			{ storeId, sourceRef },
			{
				$set: { status: "failed", error: message, updatedAt: new Date() },
				$setOnInsert: {
					_id: new ObjectId(),
					title,
					chars: 0,
					chunkCount: 0,
					embeddingModel: null,
					indexedAt: null,
					createdAt: new Date(),
				},
			},
			{ upsert: true }
		);
	} catch (err) {
		logger.warn({ err, sourceRef }, "knowledge_mark_failed_unrecorded");
	}
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

/**
 * The indexed text of one document, for mounting into the browser's code
 * execution runtime.
 *
 * This is the retrieval payload, not the original upload: what a question
 * against this base can see is exactly what the runtime gets, and the
 * gateway forwarder's decision not to serve raw uploaded bytes back through
 * this origin stands. Access is the same viewer-level check every other
 * read takes, and the 50 MB runtime cap is enforced here too — a refusal
 * with the number in it, not a truncated payload.
 */
export async function readDocumentText(
	storeId: string,
	documentId: string,
	caller: Caller
): Promise<{ id: string; title: string; filename: string | null; text: string; chars: number }> {
	const base = await reachableStore(storeId, caller);
	let id: ObjectId;
	try {
		id = new ObjectId(documentId);
	} catch {
		throw new KnowledgeError(404, "No such document.");
	}
	const document = await collections.knowledgeDocuments.findOne({
		_id: id,
		storeId: base._id,
	});
	if (!document) throw new KnowledgeError(404, "No such document.");
	if (typeof document.text !== "string") {
		throw new KnowledgeError(
			409,
			`"${document.title}" has no indexed text yet (status: ${document.status}).`
		);
	}
	const { MAX_FILE_BYTES } = await import("$lib/utils/execution/protocol");
	if (Buffer.byteLength(document.text, "utf8") > MAX_FILE_BYTES) {
		throw new KnowledgeError(
			413,
			`"${document.title}" is larger than the 50 MB the execution runtime accepts.`
		);
	}
	return {
		id: document._id.toString(),
		title: document.title,
		filename: document.filename ?? null,
		text: document.text,
		chars: document.chars,
	};
}

/**
 * The Knowledge screen's preview: the document's extracted markdown, exactly
 * as retrieval sees it.
 *
 * A read of `knowledge_documents.text`, never a re-extraction — `/v1/ocr` is
 * priced per page, so reading the stored text back is free and re-reading the
 * file would bill the same pages again. Same viewer-level gate and same shape
 * as `readDocumentText` by construction: this is the document-facing route's
 * name for that read, distinct from the runtime's `.../content` mount.
 */
export async function readDocumentPreview(
	storeId: string,
	documentId: string,
	caller: Caller
): Promise<{ id: string; title: string; filename: string | null; text: string; chars: number }> {
	return readDocumentText(storeId, documentId, caller);
}

/**
 * The largest original a download serves, in bytes. Every stored file arrived
 * through `storeUpload`, which refuses anything over `MAX_UPLOAD_BYTES`, so
 * this cap never blocks a legitimate download — it bounds the GridFS read
 * against entries that did not arrive that way.
 */
export const MAX_DOWNLOAD_BYTES = MAX_UPLOAD_BYTES;

/**
 * The Knowledge screen's download: the document's original bytes from the
 * chat's own GridFS.
 *
 * Viewer-level gate, like every other read — the owner and viewer shares may
 * fetch, anyone else gets the same 404 as an unreachable store. A text-only
 * document (a pasted note, a transcript) has no original bytes, so there is
 * nothing to serve and the answer is 404, not an empty file. The caller
 * serves the bytes with an attachment disposition, never inline.
 */
export async function readDocumentDownload(
	storeId: string,
	documentId: string,
	caller: Caller
): Promise<{ bytes: Buffer; filename: string; mime: string; size: number }> {
	const base = await reachableStore(storeId, caller);
	let id: ObjectId;
	try {
		id = new ObjectId(documentId);
	} catch {
		throw new KnowledgeError(404, "No such document.");
	}
	const document = await collections.knowledgeDocuments.findOne({
		_id: id,
		storeId: base._id,
	});
	if (!document) throw new KnowledgeError(404, "No such document.");
	if (!document.fileId) {
		throw new KnowledgeError(404, `"${document.title}" has no original file to download.`);
	}
	const stored = await bucket().find({ _id: document.fileId }).next();
	if (!stored) throw new KnowledgeError(404, "No such document.");
	// The declared length first: refusing before the body is read, the same
	// boundary the upload and execution paths enforce, rather than streaming
	// the whole file and discarding it.
	if (stored.length > MAX_DOWNLOAD_BYTES) {
		throw new KnowledgeError(
			413,
			`"${document.title}" is larger than the ${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB download limit.`
		);
	}
	const bytes = await readStoredFile(document.fileId);
	if (bytes.length > MAX_DOWNLOAD_BYTES) {
		throw new KnowledgeError(
			413,
			`"${document.title}" is larger than the ${Math.floor(MAX_DOWNLOAD_BYTES / (1024 * 1024))} MB download limit.`
		);
	}
	return {
		bytes,
		filename: document.filename ?? stored.filename ?? "document",
		mime: (stored.metadata?.mime as string | undefined) ?? "application/octet-stream",
		size: bytes.length,
	};
}

export async function deleteDocument(
	storeId: string,
	documentId: string,
	caller: Caller
): Promise<void> {
	await reachableStore(storeId, caller, "editor");
	// Scoped to the store the caller may edit: a document id from another
	// base is nothing of theirs to delete.
	const document = await collections.knowledgeDocuments.findOne({
		_id: new ObjectId(documentId),
		storeId: new ObjectId(storeId),
	});
	if (!document) return;
	await deleteDerived({ documentIds: document._id });
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
			// Over-fetch past the caller's limit: hits whose document row is
			// gone are dropped below ("no row, no passage"), so asking for
			// exactly `limit` would return short pages — or nothing — while
			// orphans outrank live passages.
			const fetchLimit = Math.min(limit * 3 + 10, 200);
			const result = await client.query(
				`SELECT c.id AS chunk_id, c.document_id AS document_id, c.ordinal, c.text,
					1 - (c.embedding::halfvec(${dims}) <=> ($3::vector)::halfvec(${dims})) AS score
				 FROM knowledge_chunks c
				 WHERE c.store_id = $1 AND c.dimensions = $2
				 ORDER BY c.embedding::halfvec(${dims}) <=> ($3::vector)::halfvec(${dims})
				 LIMIT $4`,
				[toUuid(base._id.toString()), dims, literal, fetchLimit]
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
				.filter((hit) => byId.has(fromUuid(hit.document_id)))
				.slice(0, limit)
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
