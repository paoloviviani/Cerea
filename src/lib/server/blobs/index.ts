import type { Db } from "mongodb";

import { readBlobConfig, type BlobConfig } from "./config";
import { GridFsBlobStore } from "./gridfs";
import { S3BlobStore } from "./s3";
import type { BlobStore } from "./types";

export * from "./types";
export { BlobConfigError, readBlobConfig, type BlobConfig, type S3Config } from "./config";
export { GridFsBlobStore } from "./gridfs";
export { S3BlobStore, BLOB_INDEX_COLLECTION } from "./s3";

/** The store a configuration names. Throws `BlobConfigError` on a bad one. */
export function createBlobStore(db: Db, config: BlobConfig): BlobStore {
	return config.kind === "s3" ? new S3BlobStore(db, config.s3) : new GridFsBlobStore(db);
}

export function blobStoreFromEnv(db: Db, get: (key: string) => string | undefined): BlobStore {
	return createBlobStore(db, readBlobConfig(get));
}
