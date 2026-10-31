/**
 * The GridFS → S3 migration tool (`scripts/blobs-migrate.mjs`), against real
 * Mongo and a real S3-compatible server (`TEST_MONGODB_URL`, `TEST_S3_ENDPOINT`).
 */
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { GridFSBucket, MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { migrate } from "../../../../scripts/blobs-migrate.mjs";
import type { S3Config } from "./config";
import { GridFsBlobStore } from "./gridfs";
import { S3BlobStore } from "./s3";

const mongoUrl = process.env.TEST_MONGODB_URL;
const endpoint = process.env.TEST_S3_ENDPOINT;

const s3: S3Config = {
	endpoint,
	region: "us-east-1",
	bucket: process.env.TEST_S3_BUCKET || "cerea-test",
	accessKeyId: process.env.TEST_S3_ACCESS_KEY,
	secretAccessKey: process.env.TEST_S3_SECRET_KEY,
	forcePathStyle: true,
	prefix: `migrate-${randomBytes(3).toString("hex")}/`,
	createBucket: true,
};

describe.skipIf(!(mongoUrl && endpoint))("blobs-migrate", () => {
	let client: MongoClient;
	let db: Db;
	let source: GridFsBlobStore;
	let target: S3BlobStore;
	const quiet = () => undefined;
	const options = () => ({ db, target: { kind: "s3", s3 }, client: target.client, log: quiet });

	beforeAll(async () => {
		client = new MongoClient(mongoUrl ?? "");
		await client.connect();
		db = client.db(`blobs-migrate-${new ObjectId().toHexString()}`);
		source = new GridFsBlobStore(db);
		target = new S3BlobStore(db, s3);
		await target.selfCheck();
	}, 60_000);
	afterAll(async () => {
		await db?.dropDatabase();
		await client?.close();
	});

	it("copies every GridFS blob, keeps ids and metadata, and is idempotent", async () => {
		const small = await source.put(
			"files",
			{ filename: "c1-abc", metadata: { conversation: "c1", mime: "text/plain" } },
			Buffer.from("hello")
		);
		const big = randomBytes(17 * 1024 * 1024);
		const large = await source.put(
			"codeOutputs",
			{ filename: "c1-big", metadata: { conversation: "c1", mime: "application/octet-stream" } },
			Readable.from([big])
		);

		const dry = await migrate({ ...options(), dryRun: true });
		expect(dry).toMatchObject({ wouldCopy: 2, migrated: 0 });
		expect(await db.collection("blobs").countDocuments()).toBe(0);

		const first = await migrate(options());
		expect(first).toMatchObject({ migrated: 2, skipped: 0, failed: 0, deleted: 0 });

		// Queryable and readable through the S3 store, under the same ids.
		const row = await target.stat("files", small.id);
		expect(row).toMatchObject({
			filename: "c1-abc",
			length: 5,
			metadata: { conversation: "c1", mime: "text/plain" },
		});
		expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(row?.uploadDate.getTime()).toBe(small.uploadDate.getTime());
		expect((await target.read("files", small.id)).toString()).toBe("hello");
		expect(await target.count("files", { "metadata.conversation": "c1" })).toBe(1);
		expect((await target.read("codeOutputs", large.id)).equals(big)).toBe(true);
		// GridFS untouched.
		expect(await source.count("files", {})).toBe(1);

		const again = await migrate(options());
		expect(again).toMatchObject({ migrated: 0, skipped: 2, failed: 0 });

		// Resumable: a new file after the first pass is the only one copied.
		await source.put(
			"files",
			{ filename: "c1-late", metadata: { conversation: "c1" } },
			Buffer.from("late")
		);
		expect(await migrate(options())).toMatchObject({ migrated: 1, skipped: 2 });
	}, 120_000);

	it("deletes the GridFS copy only after both copies verify", async () => {
		const fine = await source.put(
			"files",
			{ filename: "d-fine", metadata: {} },
			Buffer.from("same bytes")
		);
		const bad = await source.put(
			"files",
			{ filename: "d-bad", metadata: {} },
			Buffer.from("original!!")
		);
		await migrate(options());

		// Same length, different bytes: only the sha256 can tell.
		await target.client.send(
			new PutObjectCommand({
				Bucket: s3.bucket,
				Key: target.key("files", bad.id),
				Body: Buffer.from("tampered!!"),
			})
		);

		const result = await migrate({ ...options(), deleteSource: true });
		expect(result.failed).toBe(1);
		expect(await source.stat("files", bad.id)).not.toBeNull();
		expect(await source.stat("files", fine.id)).toBeNull();
		expect((await target.read("files", fine.id)).toString()).toBe("same bytes");
		expect(
			await new GridFSBucket(db, { bucketName: "files" }).find({ _id: bad.id }).hasNext()
		).toBe(true);
	}, 120_000);
});
