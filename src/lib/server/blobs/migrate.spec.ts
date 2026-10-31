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

		const result = await migrate({ ...options(), deleteSource: true, activeStore: "s3" });
		expect(result.failed).toBe(1);
		expect(await source.stat("files", bad.id)).not.toBeNull();
		expect(await source.stat("files", fine.id)).toBeNull();
		expect((await target.read("files", fine.id)).toString()).toBe("same bytes");
		expect(
			await new GridFSBucket(db, { bucketName: "files" }).find({ _id: bad.id }).hasNext()
		).toBe(true);
	}, 120_000);

	/** A database and store of its own, so a case sees only what it seeds. */
	async function fresh() {
		const own = client.db(`blobs-migrate-${new ObjectId().toHexString()}`);
		const config = { ...s3, prefix: `migrate-${randomBytes(3).toString("hex")}/` };
		const store = new S3BlobStore(own, config, target.client);
		const run = (extra: Record<string, unknown> = {}) =>
			migrate({
				db: own,
				target: { kind: "s3", s3: config },
				client: target.client,
				log: quiet,
				...extra,
			});
		return { own, store, source: new GridFsBlobStore(own), run };
	}

	it("never resurrects a file deleted after the switch, and leaves unverified GridFS files alone", async () => {
		const { store, source, run } = await fresh();
		const gone = await source.put("files", { filename: "gone", metadata: {} }, Buffer.from("gone"));
		const kept = await source.put("files", { filename: "kept", metadata: {} }, Buffer.from("kept"));
		await run();
		// The chat is on s3 now and a user deletes one file there.
		await store.delete("files", gone.id);

		const catchUp = await run({ activeStore: "s3" });
		expect(catchUp).toMatchObject({ migrated: 0, notCopied: 1, failed: 0 });
		expect(await store.stat("files", gone.id)).toBeNull();
		await expect(store.open("files", gone.id)).rejects.toThrow();

		const cleanup = await run({ activeStore: "s3", deleteSource: true });
		expect(cleanup).toMatchObject({ deleted: 1, notCopied: 1, failed: 0 });
		expect(await source.stat("files", kept.id)).toBeNull();
		// The unverified one stays in GridFS: nothing proved it safe to drop.
		expect(await source.stat("files", gone.id)).not.toBeNull();
		expect(await store.stat("files", gone.id)).toBeNull();
		expect((await store.read("files", kept.id)).toString()).toBe("kept");
	}, 120_000);

	it("refuses to copy once the chat writes to the bucket, whatever CHAT_BLOB_STORE says", async () => {
		const { store, source, run } = await fresh();
		const gone = await source.put("files", { filename: "gone", metadata: {} }, Buffer.from("gone"));
		await run();
		// Switched: the chat writes a new file to s3 and a user deletes an old one.
		await store.put("files", { filename: "new", metadata: {} }, Buffer.from("new"));
		await store.delete("files", gone.id);
		// A stale shell without CHAT_BLOB_STORE runs the tool as if still on GridFS.
		await expect(run()).rejects.toThrow(/already stores files in the bucket/);
		expect(await store.stat("files", gone.id)).toBeNull();
	}, 120_000);

	it("removes from S3 what was deleted in GridFS before the switch", async () => {
		const { store, source, run } = await fresh();
		const doomed = await source.put("files", { filename: "d", metadata: {} }, Buffer.from("d"));
		await run();
		await source.delete("files", doomed.id);

		const dry = await run({ dryRun: true });
		expect(dry.wouldPrune).toBe(1);
		expect(await store.stat("files", doomed.id)).not.toBeNull();

		expect(await run()).toMatchObject({ pruned: 1, failed: 0 });
		expect(await store.stat("files", doomed.id)).toBeNull();
		await expect(store.open("files", doomed.id)).rejects.toThrow();
	}, 120_000);

	it("refreshes the metadata of files already copied", async () => {
		const { store, source, run } = await fresh();
		const file = await source.put(
			"files",
			{ filename: "m", metadata: { owner: "old", owners: ["a"] } },
			Buffer.from("m")
		);
		await run();
		// An owner merge and a preview owner list change in GridFS after the copy.
		await source.update("files", { _id: file.id }, { $set: { "metadata.owner": "new" } });
		await source.update("files", { _id: file.id }, { $addToSet: { "metadata.owners": "b" } });

		expect(await run()).toMatchObject({ migrated: 0, refreshed: 1 });
		expect((await store.stat("files", file.id))?.metadata).toMatchObject({
			owner: "new",
			owners: ["a", "b"],
		});
		expect(await run()).toMatchObject({ refreshed: 0 });
	}, 120_000);

	it("refuses --delete-source while the chat is still on GridFS, and never prunes what it deleted itself", async () => {
		const { store, source, run } = await fresh();
		const file = await source.put("files", { filename: "x", metadata: {} }, Buffer.from("x"));
		await run();
		await expect(run({ deleteSource: true })).rejects.toThrow(/CHAT_BLOB_STORE=s3/);
		expect(await source.stat("files", file.id)).not.toBeNull();

		await run({ activeStore: "s3", deleteSource: true });
		expect(await source.stat("files", file.id)).toBeNull();
		// A mistaken re-run on the GridFS setting must not treat the deleted source as a deletion.
		expect(await run()).toMatchObject({ pruned: 0 });
		expect((await store.read("files", file.id)).toString()).toBe("x");
	}, 120_000);
});
