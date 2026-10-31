/**
 * The blob-store seam.
 *
 * Every byte Cerea keeps as a file (message attachments and their extracted
 * text, produced deliverables, knowledge-base uploads, project documents,
 * Office previews) goes through `BlobStore`. Nothing outside `blobs/` may touch
 * `GridFSBucket`, `files.files` or an S3 client directly (a test enforces it).
 *
 * Two logical buckets keep what they always kept apart: `files` (attachments,
 * previews, uploads) and `codeOutputs` (execute_code deliverables).
 *
 * **Where queryable metadata lives.** Code asks questions of a blob's
 * metadata: which blobs belong to this conversation, which uploads are older
 * than the grace period, which previews name this owner. Those questions are
 * Mongo filters over one row per blob, never a backend's own metadata search:
 *
 * - GridFS: the row *is* GridFS's own `<bucket>.files` document, so a database
 *   that already has files needs no migration.
 * - S3: the row is a document in the `blobs` collection, written by the store
 *   beside the object and removed with it.
 *
 * Both shapes use the same field names (`_id`, `filename`, `length`,
 * `uploadDate`, `metadata.*`), so a filter means the same thing on either.
 */

import type { Readable } from "node:stream";
import type { Document, ObjectId } from "mongodb";

export type BlobBucket = "files" | "codeOutputs";

/** One stored blob, as its index row describes it. */
export interface BlobInfo {
	id: ObjectId;
	bucket: BlobBucket;
	/** The name it was stored under (`<owner>-<sha>`, `preview-<v>-<sha>`, an upload's own name). */
	filename: string;
	/** Size in bytes. */
	length: number;
	uploadDate: Date;
	contentType?: string;
	/** The digest of the bytes, when the backend recorded one (S3 rows always carry it). */
	sha256?: string;
	/** What callers tagged it with (`conversation`, `mime`, `owner`, `owners`, ...). */
	metadata: Record<string, unknown>;
}

export interface PutOptions {
	/** Fixed id, for callers that name the blob in another row before it is written. */
	id?: ObjectId;
	filename: string;
	contentType?: string;
	metadata?: Record<string, unknown>;
}

export interface FindOptions {
	sort?: Record<string, 1 | -1>;
	limit?: number;
}

/** A Mongo filter over `_id`, `filename`, `length`, `uploadDate` and `metadata.*`. */
export type BlobFilter = Document;

/** A Mongo update (`$set`, `$addToSet`, `$pull`) over `metadata.*`. */
export type BlobUpdate = Document;

export class BlobNotFoundError extends Error {
	constructor(
		readonly bucket: BlobBucket,
		readonly id: string
	) {
		super(`No such blob: ${bucket}/${id}`);
		this.name = "BlobNotFoundError";
	}
}

export function isBlobNotFound(err: unknown): boolean {
	return (
		err instanceof BlobNotFoundError ||
		(err instanceof Error &&
			/FileNotFound|File not found|NoSuchKey/.test(`${err.name} ${err.message}`))
	);
}

export interface BlobStore {
	readonly kind: "gridfs" | "s3";

	/**
	 * Store bytes. A stream is written as it arrives (multipart on S3), never
	 * collected in memory. Resolves once the bytes are durable and the index row
	 * exists.
	 */
	put(bucket: BlobBucket, options: PutOptions, body: Uint8Array | Readable): Promise<BlobInfo>;

	/** The bytes as a stream. `range.end` is inclusive. Throws `BlobNotFoundError`. */
	open(
		bucket: BlobBucket,
		id: ObjectId,
		options?: { range?: { start: number; end?: number } }
	): Promise<Readable>;

	/** The whole blob as a Buffer: for callers that need it all anyway (a parser, a base64 body). */
	read(bucket: BlobBucket, id: ObjectId): Promise<Buffer>;

	/** The index row, or null. */
	stat(bucket: BlobBucket, id: ObjectId): Promise<BlobInfo | null>;

	find(bucket: BlobBucket, filter: BlobFilter, options?: FindOptions): Promise<BlobInfo[]>;
	findOne(bucket: BlobBucket, filter: BlobFilter, options?: FindOptions): Promise<BlobInfo | null>;
	/** Rows one at a time, for sweeps and migrations that must not hold a whole bucket. */
	iterate(bucket: BlobBucket, filter: BlobFilter, options?: FindOptions): AsyncIterable<BlobInfo>;
	count(bucket: BlobBucket, filter: BlobFilter): Promise<number>;
	distinct(bucket: BlobBucket, field: string, filter: BlobFilter): Promise<unknown[]>;

	/** Update index rows (never the bytes). Returns how many rows changed. */
	update(bucket: BlobBucket, filter: BlobFilter, update: BlobUpdate): Promise<number>;

	/** Delete the bytes and the row. Throws `BlobNotFoundError` when there is no such blob. */
	delete(bucket: BlobBucket, id: ObjectId): Promise<void>;
	/** Delete many; one failure does not strand the rest. Missing blobs count as deleted. */
	deleteMany(
		bucket: BlobBucket,
		ids: readonly ObjectId[]
	): Promise<{ deleted: number; failed: { id: ObjectId; error: unknown }[] }>;

	ensureIndexes(): Promise<void>;
	/** Boot check: throws with a clear message when the store cannot be used. */
	selfCheck(): Promise<void>;
}
