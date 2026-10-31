/**
 * Helpers for specs that seed or inspect stored files. They go through the
 * blob store like production code, so a spec means the same on either backend
 * (`CHAT_BLOB_STORE=s3` runs the same specs against an S3-compatible server).
 */
import { ObjectId } from "mongodb";

import type { BlobBucket, BlobFilter } from "./types";

async function store() {
	const { collections } = await import("$lib/server/database");
	return collections.blobStore;
}

/** Store a small blob; resolves with its id once it is durable. */
export async function putBlob(
	filename: string,
	metadata: Record<string, unknown> = {},
	bytes: Buffer | string = "bytes",
	bucket: BlobBucket = "files",
	id: ObjectId = new ObjectId()
): Promise<ObjectId> {
	const info = await (
		await store()
	).put(bucket, { id, filename, metadata }, typeof bytes === "string" ? Buffer.from(bytes) : bytes);
	return info.id;
}

export async function countBlobs(filter: BlobFilter = {}, bucket: BlobBucket = "files") {
	return (await store()).count(bucket, filter);
}

export async function findBlobs(filter: BlobFilter = {}, bucket: BlobBucket = "files") {
	return (await store()).find(bucket, filter);
}

/** Delete every blob matching the filter (bytes and index rows). */
export async function removeBlobs(filter: BlobFilter = {}, bucket: BlobBucket = "files") {
	const s = await store();
	const rows = await s.find(bucket, filter);
	await s.deleteMany(
		bucket,
		rows.map((row) => row.id)
	);
}

/** Backdate (or set) a blob's upload date, for retention and grace-period specs. */
export async function setUploadDate(id: ObjectId, uploadDate: Date, bucket: BlobBucket = "files") {
	await (await store()).update(bucket, { _id: id }, { $set: { uploadDate } });
}
