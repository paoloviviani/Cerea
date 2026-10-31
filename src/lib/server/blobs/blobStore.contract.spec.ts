/**
 * One contract, both backends. GridFS always runs (real Mongo, `TEST_MONGODB_URL`);
 * the S3 store runs when `TEST_S3_ENDPOINT` names an S3-compatible server (RustFS
 * in CI and locally; see docs/storage.md). Nothing here is specific to one backend
 * except the cases labelled so.
 */
import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { MongoClient, ObjectId, type Db } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { BlobNotFoundError, type BlobStore } from "./types";
import { GridFsBlobStore } from "./gridfs";
import { S3BlobStore } from "./s3";
import type { S3Config } from "./config";

const mongoUrl = process.env.TEST_MONGODB_URL;
const s3Endpoint = process.env.TEST_S3_ENDPOINT;

const s3Config = (over: Partial<S3Config> = {}): S3Config => ({
	endpoint: s3Endpoint,
	region: "us-east-1",
	bucket: process.env.TEST_S3_BUCKET || "cerea-test",
	accessKeyId: process.env.TEST_S3_ACCESS_KEY,
	secretAccessKey: process.env.TEST_S3_SECRET_KEY,
	forcePathStyle: true,
	prefix: "",
	createBucket: true,
	...over,
});

let client: MongoClient;
let db: Db;

beforeAll(async () => {
	client = new MongoClient(mongoUrl ?? "mongodb://127.0.0.1:27017/");
	await client.connect();
	db = client.db(`blobstore-contract-${new ObjectId().toHexString()}`);
});
afterAll(async () => {
	await db?.dropDatabase();
	await client?.close();
});

const sha256 = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

/** A stream of `parts` chunks of 1 MiB of random bytes, never held whole, with its digest. */
function randomStream(parts: number) {
	const hash = createHash("sha256");
	const stream = Readable.from(
		(async function* () {
			for (let i = 0; i < parts; i += 1) {
				const chunk = randomBytes(1024 * 1024);
				hash.update(chunk);
				yield chunk;
			}
		})()
	);
	let digest: string | undefined;
	return { stream, digest: () => (digest ??= hash.digest("hex")) };
}

async function digestOf(stream: Readable) {
	const hash = createHash("sha256");
	let length = 0;
	for await (const chunk of stream) {
		hash.update(chunk as Buffer);
		length += (chunk as Buffer).length;
	}
	return { sha256: hash.digest("hex"), length };
}

function contract(name: string, make: () => BlobStore, enabled: boolean) {
	describe.skipIf(!enabled)(`BlobStore contract: ${name}`, () => {
		let store: BlobStore;
		beforeAll(async () => {
			store = make();
			await store.selfCheck();
			await store.ensureIndexes();
		}, 60_000);

		it("stores bytes and reads them back with their row", async () => {
			const info = await store.put(
				"files",
				{
					filename: "c1-abc",
					contentType: "text/plain",
					metadata: { conversation: "c1", mime: "text/plain" },
				},
				Buffer.from("hello blobs")
			);
			expect(info).toMatchObject({
				bucket: "files",
				filename: "c1-abc",
				length: 11,
				metadata: { conversation: "c1", mime: "text/plain" },
			});
			expect(info.uploadDate).toBeInstanceOf(Date);
			expect((await store.read("files", info.id)).toString()).toBe("hello blobs");
			expect(await store.stat("files", info.id)).toMatchObject({ length: 11, filename: "c1-abc" });
		});

		it("keeps the caller's id when given one, and refuses to overwrite it", async () => {
			const id = new ObjectId();
			await store.put("files", { id, filename: "fixed" }, Buffer.from("a"));
			expect((await store.stat("files", id))?.id.equals(id)).toBe(true);
			await expect(
				store.put("files", { id, filename: "fixed" }, Buffer.from("b"))
			).rejects.toThrow();
			expect((await store.read("files", id)).toString()).toBe("a");
		});

		it("streams a multi-chunk body in without collecting it", async () => {
			const body = Buffer.concat([randomBytes(300_000), randomBytes(300_000)]);
			const info = await store.put(
				"files",
				{ filename: "stream", metadata: {} },
				Readable.from([body.subarray(0, 300_000), body.subarray(300_000)])
			);
			expect(info.length).toBe(body.length);
			expect(sha256(await store.read("files", info.id))).toBe(sha256(body));
		});

		it("stores a large object (multipart on S3) and streams it out intact", async () => {
			const { stream, digest } = randomStream(21);
			const info = await store.put("files", { filename: "large", metadata: { big: true } }, stream);
			expect(info.length).toBe(21 * 1024 * 1024);
			if (store.kind === "s3") expect(info.sha256).toBe(digest());
			const back = await digestOf(await store.open("files", info.id));
			expect(back).toEqual({ sha256: digest(), length: 21 * 1024 * 1024 });
			await store.delete("files", info.id);
		}, 120_000);

		it("serves a byte range, end inclusive", async () => {
			const info = await store.put("files", { filename: "range" }, Buffer.from("0123456789"));
			const chunks: Buffer[] = [];
			for await (const c of await store.open("files", info.id, { range: { start: 2, end: 5 } }))
				chunks.push(c as Buffer);
			expect(Buffer.concat(chunks).toString()).toBe("2345");
			const tail: Buffer[] = [];
			for await (const c of await store.open("files", info.id, { range: { start: 7 } }))
				tail.push(c as Buffer);
			expect(Buffer.concat(tail).toString()).toBe("789");
		});

		it("reports a missing blob the same way everywhere", async () => {
			const id = new ObjectId();
			expect(await store.stat("files", id)).toBeNull();
			await expect(store.open("files", id)).rejects.toBeInstanceOf(BlobNotFoundError);
			await expect(store.read("files", id)).rejects.toBeInstanceOf(BlobNotFoundError);
			await expect(store.delete("files", id)).rejects.toBeInstanceOf(BlobNotFoundError);
			expect(await store.deleteMany("files", [id])).toEqual({ deleted: 1, failed: [] });
		});

		it("deletes the bytes and the row together", async () => {
			const info = await store.put(
				"files",
				{ filename: "gone", metadata: { k: 1 } },
				Buffer.from("x")
			);
			await store.delete("files", info.id);
			expect(await store.stat("files", info.id)).toBeNull();
			expect(await store.count("files", { _id: info.id })).toBe(0);
			await expect(store.open("files", info.id)).rejects.toBeInstanceOf(BlobNotFoundError);
		});

		it("deletes many, counting what was already gone", async () => {
			const a = await store.put("files", { filename: "m1" }, Buffer.from("1"));
			const b = await store.put("files", { filename: "m2" }, Buffer.from("2"));
			const result = await store.deleteMany("files", [a.id, b.id, new ObjectId()]);
			expect(result).toEqual({ deleted: 3, failed: [] });
			expect(await store.count("files", { _id: { $in: [a.id, b.id] } })).toBe(0);
		});

		it("answers metadata queries from the index, not from the backend", async () => {
			const tag = new ObjectId().toHexString();
			const ids = [];
			for (const [i, mime] of ["image/png", "text/plain", "image/png"].entries()) {
				ids.push(
					(
						await store.put(
							"files",
							{
								filename: `${tag}-${i}`,
								metadata: { conversation: tag, mime, messageId: `m${i}` },
							},
							Buffer.from(`b${i}`)
						)
					).id
				);
			}
			expect(await store.count("files", { "metadata.conversation": tag })).toBe(3);
			expect(
				await store.count("files", { "metadata.conversation": tag, "metadata.mime": "image/png" })
			).toBe(2);
			const sorted = await store.find(
				"files",
				{ "metadata.conversation": tag },
				{ sort: { filename: -1 }, limit: 2 }
			);
			expect(sorted.map((r) => r.filename)).toEqual([`${tag}-2`, `${tag}-1`]);
			expect((await store.findOne("files", { filename: `${tag}-0` }))?.id.equals(ids[0])).toBe(
				true
			);
			expect(await store.findOne("files", { filename: "nope" })).toBeNull();
			expect(
				(await store.distinct("files", "metadata.mime", { "metadata.conversation": tag })).sort()
			).toEqual(["image/png", "text/plain"]);
			const seen = [];
			for await (const row of store.iterate(
				"files",
				{ "metadata.conversation": tag },
				{ sort: { _id: 1 } }
			))
				seen.push(row.id.toString());
			expect(seen).toEqual(ids.map(String));
			// Regex and range filters, as the sweeps and the erasure code use them.
			expect(
				await store.count("files", { "metadata.conversation": { $regex: `^${tag.slice(0, 8)}` } })
			).toBe(3);
			expect(
				await store.count("files", {
					"metadata.conversation": tag,
					uploadDate: { $lt: new Date(0) },
				})
			).toBe(0);
			await store.deleteMany("files", ids);
		});

		it("updates rows in place, for the owner lists previews keep", async () => {
			const info = await store.put(
				"files",
				{ filename: "preview-x", metadata: { preview: true, owners: ["a"] } },
				Buffer.from("pdf")
			);
			expect(
				await store.update("files", { _id: info.id }, { $addToSet: { "metadata.owners": "b" } })
			).toBe(1);
			expect((await store.stat("files", info.id))?.metadata.owners).toEqual(["a", "b"]);
			await store.update(
				"files",
				{ _id: info.id },
				{ $pull: { "metadata.owners": { $in: ["a"] } } }
			);
			expect((await store.stat("files", info.id))?.metadata.owners).toEqual(["b"]);
			const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
			await store.update("files", { _id: info.id }, { $set: { uploadDate: old } });
			expect((await store.stat("files", info.id))?.uploadDate.getTime()).toBe(old.getTime());
			await store.delete("files", info.id);
		});

		it("keeps the two buckets apart", async () => {
			const id = new ObjectId();
			await store.put(
				"codeOutputs",
				{ id, filename: "deliverable", metadata: { conversation: "c" } },
				Buffer.from("out")
			);
			expect(await store.stat("files", id)).toBeNull();
			await expect(store.open("files", id)).rejects.toBeInstanceOf(BlobNotFoundError);
			expect(await store.count("files", { filename: "deliverable" })).toBe(0);
			expect(await store.count("codeOutputs", { filename: "deliverable" })).toBe(1);
			expect((await store.read("codeOutputs", id)).toString()).toBe("out");
			await store.delete("codeOutputs", id);
		});
	});
}

contract("gridfs", () => new GridFsBlobStore(db), Boolean(mongoUrl));
contract("s3", () => new S3BlobStore(db, s3Config()), Boolean(mongoUrl && s3Endpoint));

describe.skipIf(!(mongoUrl && s3Endpoint))("S3 store specifics", () => {
	it("isolates two prefixes in one bucket", async () => {
		const a = new S3BlobStore(db, s3Config({ prefix: "team-a/" }));
		const b = new S3BlobStore(db, s3Config({ prefix: "team-b/" }));
		const info = await a.put("files", { filename: "p" }, Buffer.from("a-only"));
		expect(a.key("files", info.id)).toBe(`team-a/files/${info.id.toHexString()}`);
		await expect(b.open("files", info.id)).rejects.toBeInstanceOf(BlobNotFoundError);
		await a.delete("files", info.id);
	});

	it("keeps no name or owner in an object key", async () => {
		const store = new S3BlobStore(db, s3Config());
		const info = await store.put(
			"files",
			{ filename: "secret-owner-name", metadata: { conversation: "c9" } },
			Buffer.from("k")
		);
		expect(store.key("files", info.id)).not.toMatch(/secret|c9/);
		await store.delete("files", info.id);
	});

	it("refuses to start on bad credentials, with the reason", async () => {
		const bad = new S3BlobStore(
			db,
			s3Config({ accessKeyId: "nope", secretAccessKey: "nopenopenope" })
		);
		await expect(bad.selfCheck()).rejects.toThrow(/Cannot reach|probe object/);
	});

	it("refuses a missing bucket unless it may create it", async () => {
		const name = `missing-${randomBytes(4).toString("hex")}`;
		await expect(
			new S3BlobStore(db, s3Config({ bucket: name, createBucket: false })).selfCheck()
		).rejects.toThrow(/does not exist/);
		const creating = new S3BlobStore(db, s3Config({ bucket: name, createBucket: true }));
		await creating.selfCheck();
		await creating.selfCheck();
	});

	it("leaves nothing behind when the index row cannot be written", async () => {
		const store = new S3BlobStore(db, s3Config());
		const id = new ObjectId();
		await store.put("files", { id, filename: "dup" }, Buffer.from("1"));
		await expect(store.put("files", { id, filename: "dup" }, Buffer.from("2"))).rejects.toThrow();
		// The first object is intact: a failed row insert removes only what that attempt wrote... and the
		// attempt used the same key, so the original must still be readable if the store kept it.
		expect(await store.stat("files", id)).not.toBeNull();
		await store.deleteMany("files", [id]);
	});

	/** A client that fails the commands named, otherwise the real thing. */
	function failing(...commands: string[]) {
		const real = new S3BlobStore(db, s3Config()).client;
		const wrapped = Object.create(real);
		wrapped.send = (command: { constructor: { name: string } }) =>
			commands.includes(command.constructor.name)
				? Promise.reject(Object.assign(new Error("MissingContentMD5"), { name: "InvalidRequest" }))
				: real.send(command as never);
		return wrapped;
	}

	it("falls back to one request per object when the store rejects DeleteObjects", async () => {
		const store = new S3BlobStore(db, s3Config(), failing("DeleteObjectsCommand"));
		const a = await store.put("files", { filename: "f1" }, Buffer.from("1"));
		const b = await store.put("files", { filename: "f2" }, Buffer.from("2"));
		expect(await store.deleteMany("files", [a.id, b.id])).toEqual({ deleted: 2, failed: [] });
		expect(await store.count("files", { _id: { $in: [a.id, b.id] } })).toBe(0);
		await expect(store.open("files", a.id)).rejects.toBeInstanceOf(BlobNotFoundError);
		// The boot probe tolerates it too.
		await store.selfCheck();
	});

	it("destroys the caller's stream when the upload fails", async () => {
		const store = new S3BlobStore(db, s3Config(), failing("PutObjectCommand"));
		const source = Readable.from([Buffer.from("never stored")]);
		await expect(store.put("files", { filename: "bad" }, source)).rejects.toThrow();
		expect(source.destroyed).toBe(true);
		expect(await store.count("files", { filename: "bad" })).toBe(0);
	});

	it("sweeps objects no row names, once they are old enough", async () => {
		const config = s3Config({ prefix: `sweep-${randomBytes(3).toString("hex")}/` });
		const store = new S3BlobStore(db, config);
		const named = await store.put("files", { filename: "named" }, Buffer.from("n"));
		const orphan = new ObjectId();
		await store.client.send(
			new PutObjectCommand({
				Bucket: config.bucket,
				Key: store.key("files", orphan),
				Body: Buffer.from("o"),
			})
		);
		// Too recent: an upload may still be waiting for its row.
		expect(await store.sweepOrphanObjects()).toBe(0);
		const later = { now: Date.now() + 2 * 3600 * 1000 };
		expect(await store.sweepOrphanObjects(later)).toBe(1);
		await expect(store.open("files", orphan)).rejects.toBeInstanceOf(BlobNotFoundError);
		expect((await store.read("files", named.id)).toString()).toBe("n");
		expect(await store.sweepOrphanObjects(later)).toBe(0);
		await store.delete("files", named.id);
	});
});
