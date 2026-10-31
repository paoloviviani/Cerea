import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { GridFSBucket, type Collection, type Db, type Document, ObjectId } from "mongodb";

import { logger } from "$lib/server/logger";
import { IndexedBlobStore } from "./indexed";
import {
	BlobNotFoundError,
	type BlobBucket,
	type BlobFilter,
	type BlobInfo,
	type PutOptions,
} from "./types";

/**
 * Today's behaviour, unchanged on disk: bytes in GridFS (`files.*` and
 * `codeOutputs.*`), and GridFS's own `<bucket>.files` documents are the index
 * rows. An existing database needs no migration to use this store.
 */
export class GridFsBlobStore extends IndexedBlobStore {
	readonly kind = "gridfs" as const;
	private readonly buckets: Record<BlobBucket, GridFSBucket>;
	private readonly files: Record<BlobBucket, Collection<Document>>;

	constructor(private readonly db: Db) {
		super();
		this.buckets = {
			files: new GridFSBucket(db, { bucketName: "files" }),
			codeOutputs: new GridFSBucket(db, { bucketName: "codeOutputs" }),
		};
		this.files = {
			files: db.collection("files.files"),
			codeOutputs: db.collection("codeOutputs.files"),
		};
	}

	protected rows(bucket: BlobBucket) {
		return this.files[bucket];
	}

	protected scope(_bucket: BlobBucket, filter: BlobFilter) {
		return filter;
	}

	protected toInfo(bucket: BlobBucket, row: Document): BlobInfo {
		return {
			id: row._id,
			bucket,
			filename: row.filename,
			length: row.length,
			uploadDate: row.uploadDate,
			contentType: row.contentType ?? row.metadata?.mime,
			metadata: row.metadata ?? {},
		};
	}

	async put(
		bucket: BlobBucket,
		options: PutOptions,
		body: Uint8Array | Readable
	): Promise<BlobInfo> {
		const id = options.id ?? new ObjectId();
		const upload = this.buckets[bucket].openUploadStreamWithId(id, options.filename, {
			metadata: { ...options.metadata },
		});
		const source = body instanceof Readable ? body : Readable.from([Buffer.from(body)]);
		await pipeline(source, upload);
		const info = await this.stat(bucket, id);
		if (!info) throw new Error(`GridFS wrote ${bucket}/${id} but its file document is missing`);
		return info;
	}

	async open(
		bucket: BlobBucket,
		id: ObjectId,
		options?: { range?: { start: number; end?: number } }
	) {
		const info = await this.stat(bucket, id);
		if (!info) throw new BlobNotFoundError(bucket, id.toString());
		const range = options?.range;
		return this.buckets[bucket].openDownloadStream(
			id,
			range ? { start: range.start, end: (range.end ?? info.length - 1) + 1 } : {}
		);
	}

	async delete(bucket: BlobBucket, id: ObjectId): Promise<void> {
		try {
			await this.buckets[bucket].delete(id);
		} catch (err) {
			if (
				err instanceof Error &&
				/FileNotFound|File not found/i.test(`${err.name} ${err.message}`)
			) {
				throw new BlobNotFoundError(bucket, id.toString());
			}
			throw err;
		}
	}

	async ensureIndexes(): Promise<void> {
		const index = (keys: Document, options: Document, what: string) =>
			this.files.files
				.createIndex(keys, options)
				.catch((e) => logger.error(e, `Error creating index for ${what}`));
		// Attachments by owner tag (and, for owner-keyed surfaces, the message
		// they were sent with): `attachmentStore.findAttachments` runs once per
		// user message on every transcript load, and both it and the deletions by
		// owner would otherwise scan the whole bucket.
		await index(
			{ "metadata.conversation": 1, "metadata.messageId": 1 },
			{},
			"attachment owner tags"
		);
		// Office previews name the source files that use them in `metadata.owners`.
		await index(
			{ "metadata.owners": 1 },
			{ partialFilterExpression: { "metadata.preview": true } },
			"office preview owners"
		);
	}

	async selfCheck(): Promise<void> {
		// GridFS is the application's own database; its connection was just made.
	}
}
