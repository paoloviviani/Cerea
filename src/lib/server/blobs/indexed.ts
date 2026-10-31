import { Readable } from "node:stream";
import { ObjectId, type Collection, type Document } from "mongodb";

import {
	BlobNotFoundError,
	type BlobBucket,
	type BlobFilter,
	type BlobInfo,
	type BlobStore,
	type BlobUpdate,
	type FindOptions,
	type PutOptions,
} from "./types";

/**
 * What both backends share: every query is a Mongo filter over the index rows,
 * so it is written once. A backend says where its rows live (`rows`), how a
 * filter is scoped to one bucket (`scope`) and how bytes move.
 */
export abstract class IndexedBlobStore implements BlobStore {
	abstract readonly kind: "gridfs" | "s3";

	protected abstract rows(bucket: BlobBucket): Collection<Document>;
	protected abstract scope(bucket: BlobBucket, filter: BlobFilter): BlobFilter;
	protected abstract toInfo(bucket: BlobBucket, row: Document): BlobInfo;

	abstract put(
		bucket: BlobBucket,
		options: PutOptions,
		body: Uint8Array | Readable
	): Promise<BlobInfo>;
	abstract open(
		bucket: BlobBucket,
		id: ObjectId,
		options?: { range?: { start: number; end?: number } }
	): Promise<Readable>;
	abstract delete(bucket: BlobBucket, id: ObjectId): Promise<void>;
	abstract ensureIndexes(): Promise<void>;
	abstract selfCheck(): Promise<void>;

	async read(bucket: BlobBucket, id: ObjectId): Promise<Buffer> {
		const chunks: Buffer[] = [];
		for await (const chunk of await this.open(bucket, id)) chunks.push(chunk as Buffer);
		return Buffer.concat(chunks);
	}

	async stat(bucket: BlobBucket, id: ObjectId): Promise<BlobInfo | null> {
		return this.findOne(bucket, { _id: id });
	}

	async find(bucket: BlobBucket, filter: BlobFilter, options?: FindOptions): Promise<BlobInfo[]> {
		let cursor = this.rows(bucket).find(this.scope(bucket, filter));
		if (options?.sort) cursor = cursor.sort(options.sort);
		if (options?.limit) cursor = cursor.limit(options.limit);
		return (await cursor.toArray()).map((row) => this.toInfo(bucket, row));
	}

	async findOne(
		bucket: BlobBucket,
		filter: BlobFilter,
		options?: FindOptions
	): Promise<BlobInfo | null> {
		const [row] = await this.find(bucket, filter, { ...options, limit: 1 });
		return row ?? null;
	}

	async *iterate(
		bucket: BlobBucket,
		filter: BlobFilter,
		options?: FindOptions
	): AsyncIterable<BlobInfo> {
		let cursor = this.rows(bucket).find(this.scope(bucket, filter));
		if (options?.sort) cursor = cursor.sort(options.sort);
		if (options?.limit) cursor = cursor.limit(options.limit);
		for await (const row of cursor) yield this.toInfo(bucket, row);
	}

	count(bucket: BlobBucket, filter: BlobFilter): Promise<number> {
		return this.rows(bucket).countDocuments(this.scope(bucket, filter));
	}

	distinct(bucket: BlobBucket, field: string, filter: BlobFilter): Promise<unknown[]> {
		return this.rows(bucket).distinct(field, this.scope(bucket, filter));
	}

	async update(bucket: BlobBucket, filter: BlobFilter, update: BlobUpdate): Promise<number> {
		const { modifiedCount } = await this.rows(bucket).updateMany(
			this.scope(bucket, filter),
			update
		);
		return modifiedCount;
	}

	async deleteMany(
		bucket: BlobBucket,
		ids: readonly ObjectId[]
	): Promise<{ deleted: number; failed: { id: ObjectId; error: unknown }[] }> {
		const failed: { id: ObjectId; error: unknown }[] = [];
		let deleted = 0;
		await Promise.all(
			ids.map((id) =>
				this.delete(bucket, id).then(
					() => {
						deleted += 1;
					},
					(error) => {
						if (error instanceof BlobNotFoundError) deleted += 1;
						else failed.push({ id, error });
					}
				)
			)
		);
		return { deleted, failed };
	}
}
