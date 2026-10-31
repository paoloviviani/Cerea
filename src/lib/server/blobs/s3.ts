import { createHash, randomUUID } from "node:crypto";
import { Readable, Transform } from "node:stream";
import {
	CreateBucketCommand,
	DeleteObjectCommand,
	DeleteObjectsCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	S3Client,
	type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { ObjectId, type Collection, type Db, type Document } from "mongodb";

import { logger } from "$lib/server/logger";
import type { S3Config } from "./config";
import { IndexedBlobStore } from "./indexed";
import {
	BlobNotFoundError,
	type BlobBucket,
	type BlobFilter,
	type BlobInfo,
	type PutOptions,
} from "./types";

/** Multipart part size: S3's minimum is 5 MiB; 8 MiB keeps a large upload to few requests. */
const PART_SIZE = 8 * 1024 * 1024;

export const BLOB_INDEX_COLLECTION = "blobs";

function isMissing(err: unknown): boolean {
	const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
	return e?.name === "NoSuchKey" || e?.name === "NotFound" || e?.$metadata?.httpStatusCode === 404;
}

/**
 * Bytes in an S3-compatible bucket, one object per blob at
 * `<prefix><bucket>/<id>`, and one row per blob in the `blobs` collection that
 * answers every query (see `types.ts`). Names and owners never appear in an
 * object key, so a key says nothing about whose file it is.
 *
 * Write order: object first, then the row, so a row never points at nothing; a
 * crash in between leaves an unreferenced object, never a visible broken file.
 * Delete order: object first, then the row, so a failed delete leaves the row
 * for the next attempt (and the sweeps) to find.
 */
export class S3BlobStore extends IndexedBlobStore {
	readonly kind = "s3" as const;
	private readonly index: Collection<Document>;

	constructor(
		db: Db,
		private readonly config: S3Config,
		readonly client: S3Client = createS3Client(config)
	) {
		super();
		this.index = db.collection(BLOB_INDEX_COLLECTION);
	}

	protected rows() {
		return this.index;
	}

	protected scope(bucket: BlobBucket, filter: BlobFilter) {
		return { ...filter, bucket };
	}

	protected toInfo(bucket: BlobBucket, row: Document): BlobInfo {
		return {
			id: row._id,
			bucket,
			filename: row.filename,
			length: row.length,
			uploadDate: row.uploadDate,
			contentType: row.contentType,
			sha256: row.sha256,
			metadata: row.metadata ?? {},
		};
	}

	key(bucket: BlobBucket, id: ObjectId): string {
		return `${this.config.prefix}${bucket}/${id.toHexString()}`;
	}

	private sse() {
		return this.config.sse
			? {
					ServerSideEncryption: this.config.sse as ServerSideEncryption,
					...(this.config.kmsKeyId ? { SSEKMSKeyId: this.config.kmsKeyId } : {}),
				}
			: {};
	}

	async put(
		bucket: BlobBucket,
		options: PutOptions,
		body: Uint8Array | Readable
	): Promise<BlobInfo> {
		const id = options.id ?? new ObjectId();
		const Key = this.key(bucket, id);
		// An S3 PUT silently replaces an object; a blob id is never reused, so a
		// second write of the same id is refused before it can touch the first.
		if (options.id && (await this.index.countDocuments({ _id: id }, { limit: 1 })) > 0) {
			throw new Error(`Blob ${bucket}/${id} already exists`);
		}

		// Measured as it streams past: the row records what was actually stored.
		const hash = createHash("sha256");
		let length = 0;
		const tap = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				hash.update(chunk);
				length += chunk.length;
				callback(null, chunk);
			},
		});
		const source = body instanceof Readable ? body : Readable.from([Buffer.from(body)]);
		source.once("error", (err) => tap.destroy(err));
		source.pipe(tap);

		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.config.bucket,
				Key,
				Body: tap,
				...(options.contentType ? { ContentType: options.contentType } : {}),
				...this.sse(),
			},
			partSize: PART_SIZE,
			queueSize: 4,
			leavePartsOnError: false,
		});
		await upload.done();

		const row = {
			_id: id,
			bucket,
			key: Key,
			filename: options.filename,
			length,
			uploadDate: new Date(),
			...(options.contentType ? { contentType: options.contentType } : {}),
			sha256: hash.digest("hex"),
			metadata: { ...options.metadata },
		};
		try {
			await this.index.insertOne(row);
		} catch (err) {
			await this.deleteObject(Key).catch(() => undefined);
			throw err;
		}
		return this.toInfo(bucket, row);
	}

	async open(
		bucket: BlobBucket,
		id: ObjectId,
		options?: { range?: { start: number; end?: number } }
	): Promise<Readable> {
		const range = options?.range;
		try {
			const out = await this.client.send(
				new GetObjectCommand({
					Bucket: this.config.bucket,
					Key: this.key(bucket, id),
					...(range ? { Range: `bytes=${range.start}-${range.end ?? ""}` } : {}),
				})
			);
			if (!(out.Body instanceof Readable)) {
				throw new Error("The S3 response carried no readable body");
			}
			return out.Body;
		} catch (err) {
			if (isMissing(err)) throw new BlobNotFoundError(bucket, id.toString());
			throw err;
		}
	}

	private async deleteObject(Key: string): Promise<void> {
		await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key }));
	}

	async delete(bucket: BlobBucket, id: ObjectId): Promise<void> {
		const row = await this.stat(bucket, id);
		if (!row) throw new BlobNotFoundError(bucket, id.toString());
		await this.deleteObject(this.key(bucket, id));
		await this.index.deleteOne({ _id: id, bucket });
	}

	override async deleteMany(bucket: BlobBucket, ids: readonly ObjectId[]) {
		const failed: { id: ObjectId; error: unknown }[] = [];
		let deleted = 0;
		for (let i = 0; i < ids.length; i += 1000) {
			const batch = ids.slice(i, i + 1000);
			try {
				const out = await this.client.send(
					new DeleteObjectsCommand({
						Bucket: this.config.bucket,
						Delete: { Objects: batch.map((id) => ({ Key: this.key(bucket, id) })), Quiet: true },
					})
				);
				const errors = new Map(
					(out.Errors ?? []).map((e) => [e.Key ?? "", e.Message ?? e.Code ?? "delete failed"])
				);
				const done: ObjectId[] = [];
				for (const id of batch) {
					const message = errors.get(this.key(bucket, id));
					if (message) failed.push({ id, error: new Error(message) });
					else done.push(id);
				}
				await this.index.deleteMany({ _id: { $in: done }, bucket });
				deleted += done.length;
			} catch (error) {
				for (const id of batch) failed.push({ id, error });
			}
		}
		return { deleted, failed };
	}

	async ensureIndexes(): Promise<void> {
		const index = (keys: Document, options: Document, what: string) =>
			this.index
				.createIndex(keys, options)
				.catch((e) => logger.error(e, `Error creating index for ${what}`));
		await index(
			{ bucket: 1, "metadata.conversation": 1, "metadata.messageId": 1 },
			{},
			"blob owner tags"
		);
		await index({ bucket: 1, filename: 1 }, {}, "blob names");
		await index({ bucket: 1, "metadata.owner": 1 }, {}, "blob owners");
		await index(
			{ bucket: 1, "metadata.owners": 1 },
			{ partialFilterExpression: { "metadata.preview": true } },
			"office preview owners"
		);
	}

	/**
	 * Refuses a store that cannot be used, with the reason: the bucket must be
	 * reachable (created when `CHAT_S3_CREATE_BUCKET` allows it), and a probe
	 * object must survive put, get and delete under the configured prefix.
	 */
	async selfCheck(): Promise<void> {
		const where = `${this.config.endpoint ?? "AWS S3"} bucket "${this.config.bucket}"`;
		try {
			await this.client.send(new HeadBucketCommand({ Bucket: this.config.bucket }));
		} catch (err) {
			if (isMissing(err) && this.config.createBucket) {
				try {
					await this.client.send(new CreateBucketCommand({ Bucket: this.config.bucket }));
					logger.info({ bucket: this.config.bucket }, "[blobs] Created the S3 bucket");
				} catch (createErr) {
					throw new Error(`Cannot create ${where}: ${describe(createErr)}`);
				}
			} else if (isMissing(err)) {
				throw new Error(
					`${where} does not exist. Create it, or set CHAT_S3_CREATE_BUCKET=true to let Cerea create it.`
				);
			} else {
				throw new Error(`Cannot reach ${where}: ${describe(err)}`);
			}
		}

		const Key = `${this.config.prefix}.cerea-probe/${randomUUID()}`;
		const payload = Buffer.from(`cerea blob store probe ${new Date().toISOString()}`);
		try {
			const Bucket = this.config.bucket;
			await new Upload({
				client: this.client,
				params: { Bucket, Key, Body: payload, ...this.sse() },
			}).done();
			await this.client.send(new HeadObjectCommand({ Bucket, Key }));
			const out = await this.client.send(new GetObjectCommand({ Bucket, Key }));
			const back = Buffer.from((await out.Body?.transformToByteArray()) ?? []);
			if (!back.equals(payload)) throw new Error("the probe object read back different bytes");
		} catch (err) {
			throw new Error(
				`${where} is reachable but a probe object could not be written and read back under prefix "${this.config.prefix}": ${describe(err)}`
			);
		} finally {
			await this.deleteObject(Key).catch((err) =>
				logger.warn({ err }, "[blobs] Could not delete the self-check probe object")
			);
		}
	}
}

function describe(err: unknown): string {
	const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
	const status = e.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : "";
	return `${e.name ?? "Error"}: ${e.message ?? String(err)}${status}`;
}

export function createS3Client(config: S3Config): S3Client {
	return new S3Client({
		region: config.region,
		...(config.endpoint ? { endpoint: config.endpoint } : {}),
		forcePathStyle: config.forcePathStyle,
		...(config.accessKeyId && config.secretAccessKey
			? {
					credentials: {
						accessKeyId: config.accessKeyId,
						secretAccessKey: config.secretAccessKey,
					},
				}
			: {}),
		// Third-party S3 implementations predate the SDK's default integrity
		// checksums; ask for them only where the API requires them.
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
}
