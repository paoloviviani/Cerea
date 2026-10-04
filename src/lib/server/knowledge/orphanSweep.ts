/**
 * The backstop for `deleteDerived`: a daily sweep of what a crash, a lost
 * race or an older release left behind.
 *
 * `deleteDerived` is the only path that removes a source, and it orders its
 * steps so that a failure leaves nothing retrievable. This is for what it
 * cannot see — a process that died between two of its steps, an ingest that
 * finished after its document was deleted, a conversation deleted while the
 * memory index was down. Three kinds of orphan, each found from the side that
 * still exists:
 *
 * - **Chunks** in Postgres whose document, or whose whole store, is gone from
 *   Mongo. These hold passage text, so they are the ones that matter.
 * - **Files** in GridFS uploaded for a knowledge base that no document points
 *   at. Only ones older than a day: an upload waits for its `attach` call, and
 *   sweeping a file somebody is about to attach would fail their upload.
 * - **Transcripts** (`chat:conversation:<id>`) whose conversation was deleted.
 * - **Attachments** in the same bucket whose conversation, share or code
 *   device is gone, and shares whose conversation is (`orphanAttachments.ts`,
 *   after the same 24 h grace). This part does not need knowledge bases to be
 *   enabled.
 *
 * It never fails loudly: each part is its own try/catch, logs and moves on,
 * and the counts are logged so a sweep that finds work is visible.
 */
import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { onExit } from "$lib/server/exitHandler";
import { knowledgeEnabled } from "$lib/server/knowledgeEnabled";
import { logger } from "$lib/server/logger";
import { sweepOrphanAttachments } from "$lib/server/files/orphanAttachments";
import { CONVERSATION_SOURCE_PREFIX, deleteDerived } from "./deleteDerived";
import { ensureSchema, fromUuid, toUuid, withClient } from "./db";

const BATCH = 500;
const UPLOAD_GRACE_MS = 24 * 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** The first sweep waits: boot has enough to do, and nothing here is urgent. */
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000;

export interface SweepCounts {
	orphanChunkDocuments: number;
	orphanChunkStores: number;
	orphanFiles: number;
	orphanTranscripts: number;
	orphanDocuments: number;
	orphanAttachments: number;
	orphanShares: number;
}

function batches<T>(items: T[], size = BATCH): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
	return out;
}

/** Which of these Mongo ids have no row in `collection`. */
async function missingFrom(
	ids: ObjectId[],
	exists: (batch: ObjectId[]) => Promise<ObjectId[]>
): Promise<ObjectId[]> {
	const missing: ObjectId[] = [];
	for (const batch of batches(ids)) {
		const found = new Set((await exists(batch)).map((id) => id.toString()));
		missing.push(...batch.filter((id) => !found.has(id.toString())));
	}
	return missing;
}

async function sweepChunks(counts: SweepCounts): Promise<void> {
	await ensureSchema();
	const { documents, stores } = await withClient(async (client) => {
		const docRows = await client.query("SELECT DISTINCT document_id FROM knowledge_chunks");
		const storeRows = await client.query("SELECT DISTINCT store_id FROM knowledge_chunks");
		return {
			documents: docRows.rows.map((r) => new ObjectId(fromUuid(r.document_id))),
			stores: storeRows.rows.map((r) => new ObjectId(fromUuid(r.store_id))),
		};
	});
	const goneDocuments = await missingFrom(documents, (batch) =>
		collections.knowledgeDocuments
			.find({ _id: { $in: batch } })
			.project<{ _id: ObjectId }>({ _id: 1 })
			.toArray()
			.then((rows) => rows.map((r) => r._id))
	);
	const goneStores = await missingFrom(stores, (batch) =>
		collections.vectorStores
			.find({ _id: { $in: batch } })
			.project<{ _id: ObjectId }>({ _id: 1 })
			.toArray()
			.then((rows) => rows.map((r) => r._id))
	);
	await withClient(async (client) => {
		for (const batch of batches(goneDocuments)) {
			await client.query("DELETE FROM knowledge_chunks WHERE document_id = ANY($1::uuid[])", [
				batch.map((id) => toUuid(id.toString())),
			]);
		}
		for (const batch of batches(goneStores)) {
			await client.query("DELETE FROM knowledge_chunks WHERE store_id = ANY($1::uuid[])", [
				batch.map((id) => toUuid(id.toString())),
			]);
		}
	});
	counts.orphanChunkDocuments = goneDocuments.length;
	counts.orphanChunkStores = goneStores.length;
}

async function sweepFiles(counts: SweepCounts, now: Date): Promise<void> {
	// A knowledge upload is the entry tagged with an owner and no
	// conversation: attachments carry `metadata.conversation` (chat and code
	// sessions alike), and only `storeUpload` writes `metadata.owner`.
	const cursor = collections.bucketFiles
		.find({
			"metadata.owner": { $type: "string" },
			"metadata.conversation": { $exists: false },
			uploadDate: { $lt: new Date(now.getTime() - UPLOAD_GRACE_MS) },
		})
		.project<{ _id: ObjectId }>({ _id: 1 });
	const candidates = (await cursor.toArray()).map((f) => f._id);
	for (const batch of batches(candidates)) {
		const referenced = new Set(
			(
				await collections.knowledgeDocuments
					.find({ fileId: { $in: batch } })
					.project<{ fileId: ObjectId }>({ fileId: 1 })
					.toArray()
			).map((d) => d.fileId.toString())
		);
		for (const id of batch.filter((id) => !referenced.has(id.toString()))) {
			try {
				await collections.bucket.delete(id);
				counts.orphanFiles++;
			} catch (err) {
				logger.warn({ err, fileId: id.toString() }, "knowledge_sweep_file_delete_failed");
			}
		}
	}
}

async function sweepTranscripts(counts: SweepCounts): Promise<void> {
	const rows = await collections.knowledgeDocuments
		.find({ sourceRef: { $regex: `^${CONVERSATION_SOURCE_PREFIX}` } })
		.project<{ _id: ObjectId; sourceRef: string }>({ _id: 1, sourceRef: 1 })
		.toArray();
	const byConversation = new Map<string, ObjectId[]>();
	for (const row of rows) {
		const id = row.sourceRef.slice(CONVERSATION_SOURCE_PREFIX.length);
		if (!/^[0-9a-f]{24}$/.test(id)) continue;
		byConversation.set(id, [...(byConversation.get(id) ?? []), row._id]);
	}
	const gone = await missingFrom(
		[...byConversation.keys()].map((id) => new ObjectId(id)),
		(batch) =>
			collections.conversations
				.find({ _id: { $in: batch } })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((found) => found.map((r) => r._id))
	);
	const documentIds = gone.flatMap((id) => byConversation.get(id.toString()) ?? []);
	for (const batch of batches(documentIds)) {
		const { documents } = await deleteDerived({ documentIds: batch });
		counts.orphanTranscripts += documents;
	}
}

/**
 * Document rows whose base is gone. A document arriving during its base's
 * delete can leave a row (and its file) with no store; nothing serves it —
 * search reads through the base — but no pass looked for it, so it stayed
 * forever. Through `deleteDerived` like everything else, so the row, its
 * chunks and its unshared file all go together. A base is never created
 * after its documents (the row is inserted with the store id already set),
 * so a live document cannot match.
 */
async function sweepDocuments(counts: SweepCounts): Promise<void> {
	const rows = await collections.knowledgeDocuments
		.find({})
		.project<{ _id: ObjectId; storeId: ObjectId }>({ _id: 1, storeId: 1 })
		.toArray();
	const byStore = new Map<string, ObjectId[]>();
	for (const row of rows) {
		const key = row.storeId.toString();
		byStore.set(key, [...(byStore.get(key) ?? []), row._id]);
	}
	const gone = await missingFrom(
		[...byStore.keys()].map((id) => new ObjectId(id)),
		(batch) =>
			collections.vectorStores
				.find({ _id: { $in: batch } })
				.project<{ _id: ObjectId }>({ _id: 1 })
				.toArray()
				.then((found) => found.map((r) => r._id))
	);
	const documentIds = gone.flatMap((id) => byStore.get(id.toString()) ?? []);
	for (const batch of batches(documentIds)) {
		const { documents } = await deleteDerived({ documentIds: batch });
		counts.orphanDocuments += documents;
	}
}

/** One pass. Resolves with what it removed; never rejects. */
export async function sweepKnowledgeOrphans(now = new Date()): Promise<SweepCounts> {
	const counts: SweepCounts = {
		orphanChunkDocuments: 0,
		orphanChunkStores: 0,
		orphanFiles: 0,
		orphanTranscripts: 0,
		orphanDocuments: 0,
		orphanAttachments: 0,
		orphanShares: 0,
	};
	// Transcripts first: deleting one removes its chunks and file along the
	// proper path, so the chunk pass below has less to find.
	const parts: [string, () => Promise<void>][] = [
		...(knowledgeEnabled()
			? ([
					["transcripts", () => sweepTranscripts(counts)],
					["documents", () => sweepDocuments(counts)],
					["chunks", () => sweepChunks(counts)],
					["files", () => sweepFiles(counts, now)],
				] as [string, () => Promise<void>][])
			: []),
		[
			"attachments",
			async () => {
				const swept = await sweepOrphanAttachments(now);
				counts.orphanAttachments = swept.files;
				counts.orphanShares = swept.shares;
			},
		],
	];
	for (const [name, run] of parts) {
		try {
			await run();
		} catch (err) {
			logger.warn({ err, part: name }, "knowledge_orphan_sweep_part_failed");
		}
	}
	logger.info(counts, "knowledge_orphan_sweep");
	return counts;
}

export class OrphanSweeper {
	private static instance: OrphanSweeper;

	private constructor() {
		const run = () => void sweepKnowledgeOrphans();
		const first = setTimeout(run, FIRST_SWEEP_DELAY_MS);
		const interval = setInterval(run, SWEEP_INTERVAL_MS);
		first.unref?.();
		interval.unref?.();
		onExit(() => {
			clearTimeout(first);
			clearInterval(interval);
		});
	}

	public static getInstance(): OrphanSweeper {
		if (!OrphanSweeper.instance) {
			OrphanSweeper.instance = new OrphanSweeper();
		}
		return OrphanSweeper.instance;
	}
}
