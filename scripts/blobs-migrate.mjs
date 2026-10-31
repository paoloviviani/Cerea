#!/usr/bin/env node
// @ts-nocheck: a plain Node script (run in the image without a TypeScript step); the specs exercise it.
/**
 * Copy every GridFS blob to the configured S3-compatible store.
 *
 *   node scripts/blobs-migrate.mjs [--dry-run] [--verify] [--delete-source]
 *                                  [--bucket files|codeOutputs|all] [--concurrency 4]
 *
 * Reads the same settings the app does: MONGODB_URL and MONGODB_DB_NAME for
 * the database, and CHAT_S3_* for the target (CHAT_BLOB_STORE need not be s3
 * yet; set it after the copy). Run it inside the chat container, where the
 * environment is already right:
 *
 *   docker compose exec chat node scripts/blobs-migrate.mjs --dry-run
 *
 * What it does, per GridFS file:
 *   1. skips it when the target already holds it (same id, same size);
 *   2. otherwise streams it to S3 (multipart for large files), measuring
 *      its sha256 on the way, then writes the index row beside it in the
 *      `blobs` collection. The row keeps the GridFS file's id, name, size,
 *      upload date and metadata, so every reference (conversation tags,
 *      knowledge file ids, deliverable rows) stays valid;
 *   3. with --verify (implied by --delete-source) reads both copies back and
 *      compares size and sha256;
 *   4. with --delete-source, and only after step 3 succeeded for that file,
 *      deletes the GridFS copy.
 *
 * It is idempotent and resumable: run it again after an interruption, or
 * again after switching CHAT_BLOB_STORE to catch files written in between.
 * It never deletes anything without --delete-source and never modifies a
 * GridFS file otherwise. Exit status 1 when any file failed.
 */
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import {
	CreateBucketCommand,
	DeleteObjectCommand,
	GetObjectCommand,
	HeadBucketCommand,
	HeadObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { GridFSBucket, MongoClient } from "mongodb";

import { readBlobConfig } from "../src/lib/server/blobs/config.ts";

const BUCKETS = ["files", "codeOutputs"];
const INDEX = "blobs";

function s3Client(config) {
	return new S3Client({
		region: config.region,
		...(config.endpoint ? { endpoint: config.endpoint } : {}),
		forcePathStyle: config.forcePathStyle,
		...(config.accessKeyId && config.secretAccessKey
			? {
					credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
				}
			: {}),
		requestChecksumCalculation: "WHEN_REQUIRED",
		responseChecksumValidation: "WHEN_REQUIRED",
	});
}

async function sha256Of(stream) {
	const hash = createHash("sha256");
	let length = 0;
	for await (const chunk of stream) {
		hash.update(chunk);
		length += chunk.length;
	}
	return { sha256: hash.digest("hex"), length };
}

/**
 * @param {any} options `{ db, target, client?, buckets?, dryRun?, verify?, deleteSource?, concurrency?, activeStore?, log? }`:
 *   `db` a mongodb `Db`, `target` the `readBlobConfig` result for s3.
 * @returns {Promise<{ migrated: number, skipped: number, failed: number, deleted: number, bytes: number, wouldCopy: number, refreshed: number, pruned: number, wouldPrune: number, notCopied: number }>}
 */
export async function migrate({
	db,
	target,
	client = s3Client(target.s3),
	buckets = BUCKETS,
	dryRun = false,
	verify = false,
	deleteSource = false,
	concurrency = 4,
	activeStore = "gridfs",
	log = console.log,
}) {
	const s3 = target.s3;
	// While the chat runs on s3 the bucket is the truth: files deleted since the
	// switch must not come back, so nothing is copied, refreshed or pruned then.
	const copying = activeStore !== "s3";
	if (deleteSource && copying) {
		throw new Error(
			"--delete-source needs CHAT_BLOB_STORE=s3: delete the GridFS copies only after the chat has switched"
		);
	}
	if (deleteSource) verify = true;
	const totals = {
		migrated: 0,
		skipped: 0,
		failed: 0,
		deleted: 0,
		bytes: 0,
		wouldCopy: 0,
		refreshed: 0,
		pruned: 0,
		wouldPrune: 0,
		notCopied: 0,
	};
	const index = db.collection(INDEX);
	// The data says whether the chat already writes to the bucket: a row the
	// migration did not make (no `migratedFrom`) can only come from the app on
	// s3. Copying then would bring back files deleted since the switch, so an
	// unset or stale CHAT_BLOB_STORE is not trusted on its own.
	if (
		copying &&
		(await index.findOne({ migratedFrom: { $exists: false } }, { projection: { _id: 1 } }))
	) {
		throw new Error(
			"the chat already stores files in the bucket (CHAT_BLOB_STORE=s3 is live): run this with CHAT_BLOB_STORE=s3, which only verifies and cleans up"
		);
	}
	const sse = s3.sse
		? { ServerSideEncryption: s3.sse, ...(s3.kmsKeyId ? { SSEKMSKeyId: s3.kmsKeyId } : {}) }
		: {};

	if (!dryRun) {
		try {
			await client.send(new HeadBucketCommand({ Bucket: s3.bucket }));
		} catch (err) {
			if (err?.$metadata?.httpStatusCode === 404 && s3.createBucket) {
				await client.send(new CreateBucketCommand({ Bucket: s3.bucket }));
			} else {
				throw new Error(
					`Cannot use S3 bucket "${s3.bucket}" at ${s3.endpoint ?? "AWS"}: ${err?.name}: ${err?.message}`
				);
			}
		}
	}

	for (const name of buckets) {
		const files = db.collection(`${name}.files`);
		const gridfs = new GridFSBucket(db, { bucketName: name });
		const keyOf = (id) => `${s3.prefix}${name}/${id.toHexString()}`;
		const total = await files.countDocuments({});
		log(`[${name}] ${total} GridFS file(s)`);

		const head = async (Key) => {
			try {
				return await client.send(new HeadObjectCommand({ Bucket: s3.bucket, Key }));
			} catch (err) {
				if (err?.$metadata?.httpStatusCode === 404) return null;
				throw err;
			}
		};

		const verifyCopy = async (row) => {
			const Key = keyOf(row._id);
			const [source, copy] = await Promise.all([
				sha256Of(gridfs.openDownloadStream(row._id)),
				client
					.send(new GetObjectCommand({ Bucket: s3.bucket, Key }))
					.then((out) => sha256Of(out.Body)),
			]);
			if (source.length !== row.length || copy.length !== row.length) {
				throw new Error(
					`size mismatch: GridFS ${source.length}, S3 ${copy.length}, row ${row.length}`
				);
			}
			if (source.sha256 !== copy.sha256) throw new Error("sha256 mismatch between GridFS and S3");
			return copy.sha256;
		};

		const one = async (row) => {
			const Key = keyOf(row._id);
			const existing = await index.findOne({ _id: row._id });
			let copied = false;
			if (!copying) {
				// s3 is live. A GridFS file with no row here was deleted since the
				// switch (or never copied): report it, never resurrect it.
				if (!existing || existing.sourceDeleted) {
					totals.notCopied += 1;
					log(`[${name}] skipped ${row._id} (${row.filename}): no verified copy in S3`);
					return;
				}
				totals.skipped += 1;
			} else if (
				existing &&
				existing.length === row.length &&
				(await head(Key))?.ContentLength === row.length
			) {
				totals.skipped += 1;
				// Metadata changes made in GridFS since the copy (an owner merge, preview owners).
				const fresh = {
					filename: row.filename,
					uploadDate: row.uploadDate,
					metadata: row.metadata ?? {},
				};
				const same =
					existing.filename === fresh.filename &&
					+existing.uploadDate === +fresh.uploadDate &&
					JSON.stringify(existing.metadata ?? {}) === JSON.stringify(fresh.metadata);
				if (!same) {
					if (!dryRun) await index.updateOne({ _id: row._id }, { $set: fresh });
					totals.refreshed += 1;
				}
			} else if (dryRun) {
				totals.wouldCopy += 1;
				totals.bytes += row.length;
				return;
			} else {
				const hash = createHash("sha256");
				const tap = new Transform({
					transform(chunk, _enc, cb) {
						hash.update(chunk);
						cb(null, chunk);
					},
				});
				const body = gridfs.openDownloadStream(row._id);
				body.once("error", (err) => tap.destroy(err));
				body.pipe(tap);
				const contentType = row.contentType ?? row.metadata?.mime;
				await new Upload({
					client,
					params: {
						Bucket: s3.bucket,
						Key,
						Body: tap,
						...(contentType ? { ContentType: contentType } : {}),
						...sse,
					},
					partSize: 8 * 1024 * 1024,
					queueSize: 4,
				}).done();
				const stored = await head(Key);
				if (stored?.ContentLength !== row.length) {
					throw new Error(`size mismatch after upload: ${stored?.ContentLength} != ${row.length}`);
				}
				await index.replaceOne(
					{ _id: row._id },
					{
						_id: row._id,
						bucket: name,
						key: Key,
						filename: row.filename,
						length: row.length,
						uploadDate: row.uploadDate,
						...(contentType ? { contentType } : {}),
						sha256: hash.digest("hex"),
						metadata: row.metadata ?? {},
						migratedFrom: "gridfs",
					},
					{ upsert: true }
				);
				totals.migrated += 1;
				totals.bytes += row.length;
				copied = true;
			}
			if (verify && !dryRun) {
				const sha = await verifyCopy(row);
				const indexed = await index.findOne({ _id: row._id });
				if (indexed?.sha256 && indexed.sha256 !== sha) throw new Error("index row sha256 differs");
			}
			if (deleteSource && !dryRun) {
				// Marked first: a crash between the two must never leave a row a later
				// prune could take for "source gone" and delete, the only copy left.
				await index.updateOne({ _id: row._id }, { $set: { sourceDeleted: true } });
				await gridfs.delete(row._id);
				totals.deleted += 1;
			}
			return copied;
		};

		let done = 0;
		const cursor = files.find({}).sort({ _id: 1 });
		const running = new Set();
		const report = () => {
			if (done % 100 === 0 || done === total) {
				log(
					`[${name}] ${done}/${total}  migrated ${totals.migrated}, already there ${totals.skipped}, failed ${totals.failed}`
				);
			}
		};
		for await (const row of cursor) {
			const task = one(row)
				.catch((err) => {
					totals.failed += 1;
					log(`[${name}] FAILED ${row._id} (${row.filename}): ${err?.message ?? err}`);
				})
				.finally(() => {
					running.delete(task);
					done += 1;
					report();
				});
			running.add(task);
			if (running.size >= concurrency) await Promise.race(running);
		}
		await Promise.all(running);

		// Copied files whose GridFS source has since been deleted (by a user, an
		// erasure, a sweep) go too, so the bucket does not keep what the chat dropped.
		if (copying) {
			for await (const row of index.find({
				bucket: name,
				migratedFrom: "gridfs",
				sourceDeleted: { $ne: true },
			})) {
				if (await files.countDocuments({ _id: row._id }, { limit: 1 })) continue;
				if (dryRun) {
					totals.wouldPrune += 1;
					continue;
				}
				try {
					await client.send(new DeleteObjectCommand({ Bucket: s3.bucket, Key: keyOf(row._id) }));
					await index.deleteOne({ _id: row._id });
					totals.pruned += 1;
				} catch (err) {
					totals.failed += 1;
					log(`[${name}] FAILED to prune ${row._id}: ${err?.message ?? err}`);
				}
			}
		}
	}

	log(
		dryRun
			? `Dry run: ${totals.wouldCopy} file(s), ${totals.bytes} byte(s) to copy; ${totals.skipped} already in S3 (${totals.refreshed} with changed metadata); ${totals.wouldPrune} to remove from S3 (deleted in GridFS).`
			: `Done: ${totals.migrated} copied (${totals.bytes} bytes), ${totals.skipped} already there (${totals.refreshed} metadata refreshed), ${totals.pruned} removed from S3 (deleted in GridFS), ${totals.deleted} GridFS copies deleted, ${totals.notCopied} GridFS files with no verified copy left alone, ${totals.failed} failed.`
	);
	return totals;
}

async function main() {
	const { values } = parseArgs({
		options: {
			"dry-run": { type: "boolean", default: false },
			verify: { type: "boolean", default: false },
			"delete-source": { type: "boolean", default: false },
			bucket: { type: "string", default: "all" },
			concurrency: { type: "string", default: "4" },
			help: { type: "boolean", short: "h", default: false },
		},
	});
	if (values.help) {
		console.log(
			"Usage: node scripts/blobs-migrate.mjs [--dry-run] [--verify] [--delete-source] [--bucket files|codeOutputs|all] [--concurrency 4]"
		);
		return 0;
	}
	if (values.bucket !== "all" && !BUCKETS.includes(values.bucket)) {
		console.error(`--bucket must be one of: ${BUCKETS.join(", ")}, all`);
		return 2;
	}
	// The target is described by the same settings the app reads, with the
	// backend forced to s3: the copy runs before CHAT_BLOB_STORE is switched.
	const target = readBlobConfig((key) => (key === "CHAT_BLOB_STORE" ? "s3" : process.env[key]));
	const activeStore = (process.env.CHAT_BLOB_STORE || "gridfs").trim().toLowerCase();
	if (values["delete-source"] && activeStore !== "s3") {
		console.error(
			"--delete-source needs CHAT_BLOB_STORE=s3: switch the chat first (docs/storage.md), then delete the GridFS copies."
		);
		return 2;
	}
	const url = process.env.MONGODB_URL;
	if (!url) {
		console.error("MONGODB_URL is not set.");
		return 2;
	}
	const mongo = new MongoClient(url);
	await mongo.connect();
	try {
		const totals = await migrate({
			db: mongo.db(process.env.MONGODB_DB_NAME || "chat-ui"),
			target,
			buckets: values.bucket === "all" ? BUCKETS : [values.bucket],
			dryRun: values["dry-run"],
			verify: values.verify,
			deleteSource: values["delete-source"],
			concurrency: Math.max(1, Number(values.concurrency) || 4),
			activeStore,
		});
		return totals.failed > 0 ? 1 : 0;
	} finally {
		await mongo.close();
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			console.error(err?.message ?? err);
			process.exit(1);
		}
	);
}
