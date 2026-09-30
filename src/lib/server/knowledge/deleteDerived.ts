/**
 * The one way anything derived from a source stops existing.
 *
 * A knowledge document fans out into three places: passages and vectors in
 * the chat's Postgres, the uploaded bytes in GridFS, and the rows a person
 * names in Mongo. Deleting "the document" used to be written out by hand at
 * each call site — Mongo first, Postgres after, GridFS not at all — which is
 * how a deleted conversation stayed retrievable and an erased account left its
 * passage text behind. Every path that removes a source now calls this, and
 * this knows the list; a fourth kind of derived thing is added here, once.
 *
 * **Order matters, and it is Postgres, GridFS, Mongo.** The Mongo row is the
 * handle that finds the rest, so it goes last: a failure halfway leaves a row
 * a retry can still find, and never chunks nobody can find. It is also the
 * order that leaves nothing *retrievable* on a partial failure — search reads
 * the chunks, so chunks go first. The daily orphan sweep is the backstop for
 * whatever a crash still strands.
 *
 * **Idempotent.** Every step is a delete by filter, and a file that is
 * already gone is not an error, so deleting twice is a no-op. That is what
 * lets an erasure resume and a sweep re-run.
 */
import { ObjectId } from "mongodb";

import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { ensureSchema, toUuid, withClient } from "./db";

type One<T> = T | T[];

export interface DerivedTarget {
	/** Conversations whose transcripts were indexed (`chat:conversation:<id>`), in any base. */
	conversationId?: One<ObjectId>;
	/** Specific documents. */
	documentIds?: One<ObjectId>;
	/** Everything inside these bases. */
	storeIds?: One<ObjectId>;
	/** With `storeIds`: also remove the base rows themselves. Off by default so an
	 * erasure's own `vectorStores` step still reports what it removed. */
	dropStores?: boolean;
}

export interface DerivedCounts {
	documents: number;
	files: number;
}

export const CONVERSATION_SOURCE_PREFIX = "chat:conversation:";

export function conversationSourceRef(id: ObjectId | string): string {
	return `${CONVERSATION_SOURCE_PREFIX}${id.toString()}`;
}

function list<T>(value: One<T> | undefined): T[] {
	if (value === undefined) return [];
	return Array.isArray(value) ? value : [value];
}

/** GridFS's "no such file": already deleted, which is what idempotent means. */
function isFileNotFound(err: unknown): boolean {
	return err instanceof Error && /FileNotFound|File not found/i.test(err.message);
}

export async function deleteDerived(target: DerivedTarget): Promise<DerivedCounts> {
	const conversationRefs = list(target.conversationId).map(conversationSourceRef);
	const documentIds = list(target.documentIds);
	const storeIds = list(target.storeIds);

	const clauses: Record<string, unknown>[] = [];
	if (conversationRefs.length > 0) clauses.push({ sourceRef: { $in: conversationRefs } });
	if (documentIds.length > 0) clauses.push({ _id: { $in: documentIds } });
	if (storeIds.length > 0) clauses.push({ storeId: { $in: storeIds } });
	if (clauses.length === 0) return { documents: 0, files: 0 };

	const docs = await collections.knowledgeDocuments
		.find({ $or: clauses })
		.project<{ _id: ObjectId; fileId?: ObjectId }>({ _id: 1, fileId: 1 })
		.toArray();
	const docIds = docs.map((doc) => doc._id);

	// 1. Postgres: the passages and their vectors. A document with no chunks
	// (or a deployment that never indexed) costs one no-op delete; when there
	// is nothing to look for the pool is not touched at all.
	if (docIds.length > 0 || storeIds.length > 0) {
		await ensureSchema();
		await withClient(async (client) => {
			if (docIds.length > 0) {
				await client.query("DELETE FROM knowledge_chunks WHERE document_id = ANY($1::uuid[])", [
					docIds.map((id) => toUuid(id.toString())),
				]);
			}
			if (storeIds.length > 0) {
				// By store as well as by document: chunks whose document row is
				// already gone (a half-failed earlier delete) still name their store.
				await client.query("DELETE FROM knowledge_chunks WHERE store_id = ANY($1::uuid[])", [
					storeIds.map((id) => toUuid(id.toString())),
				]);
			}
		});
	}

	// 2. GridFS: the uploaded bytes — unless a document that is staying still
	// points at the same file.
	const fileIds = docs.flatMap((doc) => (doc.fileId ? [doc.fileId] : []));
	let files = 0;
	if (fileIds.length > 0) {
		const stillUsed = new Set(
			(
				await collections.knowledgeDocuments
					.find({ fileId: { $in: fileIds }, _id: { $nin: docIds } })
					.project<{ fileId: ObjectId }>({ fileId: 1 })
					.toArray()
			).map((row) => row.fileId.toString())
		);
		const doomed = [...new Set(fileIds.map((id) => id.toString()))]
			.filter((id) => !stillUsed.has(id))
			.map((id) => new ObjectId(id));
		const results = await Promise.allSettled(doomed.map((id) => collections.bucket.delete(id)));
		const failed = results.filter(
			(r): r is PromiseRejectedResult => r.status === "rejected" && !isFileNotFound(r.reason)
		);
		files = results.length - failed.length;
		if (failed.length > 0) {
			// Thrown before the Mongo rows go: the rows are what a retry finds.
			logger.error({ failed: failed.length }, "knowledge_derived_file_delete_failed");
			throw failed[0].reason;
		}
	}

	// 3. Mongo: the rows a person names, last.
	if (docIds.length > 0) {
		await collections.knowledgeDocuments.deleteMany({ _id: { $in: docIds } });
	}
	if (storeIds.length > 0) {
		// A document that landed between the read above and now.
		await collections.knowledgeDocuments.deleteMany({ storeId: { $in: storeIds } });
		if (target.dropStores) await collections.vectorStores.deleteMany({ _id: { $in: storeIds } });
	}
	return { documents: docIds.length, files };
}
