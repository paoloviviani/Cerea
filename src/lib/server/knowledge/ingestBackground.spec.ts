/**
 * Background ingestion, against a real Postgres and a real Mongo.
 *
 * `attachFile`/`addText` default to the synchronous form; with
 * `{ background: true }` the row is the response and the OCR+embedding work
 * finishes behind it. Gated on `TEST_DATABASE_URL` (skipped without it), and
 * on `TEST_MONGODB_URL` for the chat's own database:
 *
 *   TEST_DATABASE_URL=postgresql://gw:pw@127.0.0.1:55442/gw \
 *   TEST_MONGODB_URL=mongodb://127.0.0.1:8801 \
 *     npx vitest run --project=server --no-file-parallelism \
 *     src/lib/server/knowledge/ingestBackground.spec.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { Pool } from "pg";
import { collections, ready } from "$lib/server/database";
import { logger } from "$lib/server/logger";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const { embedMock, extractMock } = vi.hoisted(() => ({ embedMock: vi.fn(), extractMock: vi.fn() }));

vi.mock("$env/dynamic/private", async () => {
	const { readFileSync } = await import("node:fs");
	const { parse } = await import("dotenv");
	const fromFile = parse(readFileSync(`${process.cwd()}/.env`, "utf-8"));
	const env: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(fromFile)) {
		if (!key.startsWith("PUBLIC_")) env[key] = value;
	}
	env.MONGODB_URL = process.env.TEST_MONGODB_URL;
	Object.defineProperty(env, "CHAT_PG_URL", {
		get: () => process.env.CHAT_PG_URL,
		enumerable: true,
	});
	return { env };
});
vi.mock("./embed", () => ({ embed: embedMock }));
vi.mock("$lib/server/files/extractDocument", () => ({
	NO_READER_MESSAGE: "no reader",
	resolveExtractorModel: async () => "reader",
	isExtractableDocument: (mime: string) => mime === "application/pdf",
	extractDocument: extractMock,
}));
vi.mock("$lib/server/admin", () => ({
	callerIdentity: async (locals: App.Locals) => ({
		email: locals.user?.email ?? null,
		groups: [],
		isAdmin: false,
	}),
}));

/** Positive, deterministic, 384 wide: the same text always embeds the same. */
function vectorFor(text: string): number[] {
	let h = 7;
	for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) % 9973;
	return Array.from({ length: 384 }, (_, i) => ((h + i * 13) % 100) / 100 + 0.01);
}

describe.skipIf(!TEST_DATABASE_URL)("background ingestion", () => {
	let pg: Pool;
	let svc: typeof import("./service");
	const dbName = `cerea_ragbg_${process.pid}`;

	const caller = (userId: ObjectId, email = "owner@example.org") => ({
		userId,
		email,
		groups: [],
		isAdmin: false,
	});

	const svcToUuid = (id: ObjectId) => {
		const hex = id.toString() + "00000000";
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};
	const chunksOfStores = async (ids: ObjectId[]): Promise<number> => {
		const uuids = ids.map((id) => svcToUuid(id));
		const res = await pg.query(
			"SELECT count(*)::int AS n FROM knowledge_chunks WHERE store_id = ANY($1::uuid[])",
			[uuids]
		);
		return res.rows[0].n;
	};

	async function waitFor(cond: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
		const start = Date.now();
		for (;;) {
			if (await cond()) return;
			if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for background work");
			await new Promise((r) => setTimeout(r, 50));
		}
	}

	const longText = (seed: string) =>
		`${seed}: ` + "A sentence about the quarterly plan and its risks. ".repeat(12);

	async function makeStore(owner: ObjectId) {
		const made = await svc.createStore(caller(owner), { name: "store" });
		return new ObjectId(made.id);
	}

	async function uploadText(owner: ObjectId, seed: string, mime = "text/plain") {
		return svc.storeUpload({ name: "bg.txt", bytes: Buffer.from(longText(seed)), mime }, owner);
	}

	function backgroundFailed(): Promise<boolean> {
		const calls = vi.mocked(logger.warn).mock.calls as unknown[][];
		return Promise.resolve(calls.some((args) => args[1] === "knowledge_background_ingest_failed"));
	}

	function need<T>(value: T | null | undefined): T {
		if (value === null || value === undefined) throw new Error("expected a value");
		return value;
	}

	beforeAll(async () => {
		const admin = new Pool({ connectionString: TEST_DATABASE_URL });
		await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
		await admin.query(`CREATE DATABASE ${dbName}`);
		await admin.end();
		const url = new URL(TEST_DATABASE_URL as string);
		url.pathname = `/${dbName}`;
		pg = new Pool({ connectionString: url.toString() });
		await pg.query("CREATE EXTENSION IF NOT EXISTS vector");
		process.env.CHAT_PG_URL = url.toString();

		await ready;
		svc = await import("./service");
		const { ensureSchema } = await import("./db");
		await ensureSchema();
		await pg.query("DELETE FROM knowledge_chunks");
		vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
	}, 60_000);

	afterAll(async () => {
		await collections.bucket.drop().catch(() => undefined);
		for (const name of [
			"vectorStores",
			"knowledgeDocuments",
			"knowledgeConfig",
			"projects",
			"conversations",
			"users",
			"erasures",
		] as const) {
			await collections[name].deleteMany({});
		}
		const { knowledgePool } = await import("./db");
		await knowledgePool().end();
		await pg.end();
		const admin = new Pool({ connectionString: TEST_DATABASE_URL });
		await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
		await admin.end();
	});

	beforeEach(async () => {
		embedMock.mockReset();
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[]) =>
			texts.map(vectorFor)
		);
		extractMock.mockReset();
		extractMock.mockResolvedValue({ ok: true, text: longText("extracted") });
		vi.mocked(logger.warn).mockClear();
		await collections.vectorStores.deleteMany({});
		await collections.knowledgeDocuments.deleteMany({});
		await collections.knowledgeConfig.deleteMany({});
		await collections.projects.deleteMany({});
		await collections.conversations.deleteMany({});
		await collections.users.deleteMany({});
		await collections.erasures.deleteMany({});
		await collections.bucketFiles.deleteMany({});
		await collections.bucket.drop().catch(() => undefined);
		await collections.knowledgeConfig.insertOne({
			enabled: true,
			embeddingModel: "embed-test",
			chunkChars: 1200,
			chunkOverlap: 150,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const { ensureSchema } = await import("./db");
		await ensureSchema();
		await pg.query("DELETE FROM knowledge_chunks");
	});

	it("returns pending immediately and reaches ready in the background", async () => {
		const owner = new ObjectId();
		const store = await makeStore(owner);
		// Hold the embedding so the return demonstrably precedes the work.
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		embedMock.mockImplementationOnce(async (_t: string, _m: string, texts: string[]) => {
			await gate;
			return texts.map(vectorFor);
		});
		const up = await uploadText(owner, "background file");

		const returned = await svc.attachFile(
			store.toString(),
			caller(owner),
			"tok",
			{ file_id: up.id },
			{ background: true }
		);
		expect(returned.status).toBe("pending");

		release();
		const docId = new ObjectId(returned.id);
		await waitFor(
			async () => (await collections.knowledgeDocuments.findOne({ _id: docId }))?.status === "ready"
		);
		expect(await chunksOfStores([store])).toBeGreaterThan(0);
	});

	it("deleting the document mid-embedding leaves no row, chunks or file, and no rejection escapes", async () => {
		const rejections: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			rejections.push(err);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			embedMock.mockImplementationOnce(async (_t: string, _m: string, texts: string[]) => {
				await gate;
				return texts.map(vectorFor);
			});
			const up = await uploadText(owner, "doomed file");
			const returned = await svc.attachFile(
				store.toString(),
				caller(owner),
				"tok",
				{ file_id: up.id },
				{ background: true }
			);
			const docId = new ObjectId(returned.id);
			// Let the worker reach the embedding, then delete the document.
			await waitFor(async () => embedMock.mock.calls.length > 0);
			await svc.deleteDocument(store.toString(), docId.toString(), caller(owner));
			release();
			// The worker's own catch is the settle signal: the post-ingest
			// checks reject, and the queue must swallow that, not the process.
			await waitFor(backgroundFailed);
			expect(await collections.knowledgeDocuments.countDocuments({ _id: docId })).toBe(0);
			expect(await chunksOfStores([store])).toBe(0);
			expect(await collections.bucketFiles.countDocuments({ _id: new ObjectId(up.id) })).toBe(0);
			await new Promise((r) => setTimeout(r, 500));
			expect(rejections).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("deleting the base mid-embedding leaves no rows, chunks or store, and no rejection escapes", async () => {
		const rejections: unknown[] = [];
		const onUnhandled = (err: unknown) => {
			rejections.push(err);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			embedMock.mockImplementationOnce(async (_t: string, _m: string, texts: string[]) => {
				await gate;
				return texts.map(vectorFor);
			});
			const up = await uploadText(owner, "doomed base file");
			const returned = await svc.attachFile(
				store.toString(),
				caller(owner),
				"tok",
				{ file_id: up.id },
				{ background: true }
			);
			const docId = new ObjectId(returned.id);
			await waitFor(async () => embedMock.mock.calls.length > 0);
			await svc.deleteStore(store.toString(), caller(owner));
			release();
			await waitFor(backgroundFailed);
			expect(await collections.vectorStores.countDocuments({ _id: store })).toBe(0);
			expect(await collections.knowledgeDocuments.countDocuments({ _id: docId })).toBe(0);
			expect(await chunksOfStores([store])).toBe(0);
			await new Promise((r) => setTimeout(r, 500));
			expect(rejections).toEqual([]);
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}
	});

	it("two concurrent retries of a failed twin extract exactly once", async () => {
		const owner = new ObjectId();
		const store = await makeStore(owner);
		const up = await svc.storeUpload(
			{
				name: "scan.pdf",
				bytes: Buffer.from(`%PDF-1.4 fake ${"x".repeat(5000)}`),
				mime: "application/pdf",
			},
			owner
		);
		extractMock.mockResolvedValueOnce({ ok: false, status: 502, reason: "ocr down" });
		const first = await svc.attachFile(store.toString(), caller(owner), "tok", {
			file_id: up.id,
		});
		expect(first.status).toBe("failed");
		const twin = await collections.knowledgeDocuments.findOne({ storeId: store });
		expect(twin?.status).toBe("failed");

		extractMock.mockClear();
		extractMock.mockResolvedValue({ ok: true, text: longText("twin retry") });
		await Promise.all([
			svc.attachFile(
				store.toString(),
				caller(owner),
				"tok",
				{ file_id: up.id },
				{ background: true }
			),
			svc.attachFile(
				store.toString(),
				caller(owner),
				"tok",
				{ file_id: up.id },
				{ background: true }
			),
		]);
		// One winner claimed the twin and drove the ingest; the loser returned it.
		await waitFor(
			async () =>
				(await collections.knowledgeDocuments.findOne({ _id: need(twin)._id }))?.status === "ready"
		);
		expect(extractMock).toHaveBeenCalledTimes(1);
		expect(await chunksOfStores([store])).toBeGreaterThan(0);
	});

	it("the boot flip fails pre-boot pendings and leaves newer and settled rows alone", async () => {
		const now = new Date();
		const row = (status: string, updatedAt: Date) => ({
			_id: new ObjectId(),
			storeId: new ObjectId(),
			title: "t",
			chars: 0,
			chunkCount: 0,
			status,
			error: "",
			embeddingModel: null,
			indexedAt: null,
			createdAt: now,
			updatedAt,
		});
		const staleId = new ObjectId();
		await collections.knowledgeDocuments.insertOne({
			...row("pending", new Date(now.getTime() - 3_600_000)),
			_id: staleId,
		} as never);
		const boot = new Date();
		const freshId = new ObjectId();
		const settledId = new ObjectId();
		await collections.knowledgeDocuments.insertOne({
			...row("pending", new Date()),
			_id: freshId,
		} as never);
		await collections.knowledgeDocuments.insertOne({
			...row("ready", new Date(now.getTime() - 3_600_000)),
			_id: settledId,
		} as never);

		expect(await svc.failInterruptedIngests(boot)).toBe(1);

		const stale = await collections.knowledgeDocuments.findOne({ _id: staleId });
		expect(stale?.status).toBe("failed");
		expect(stale?.error).toBe("Indexing was interrupted by a restart; upload it again or reindex.");
		expect((await collections.knowledgeDocuments.findOne({ _id: freshId }))?.status).toBe(
			"pending"
		);
		expect((await collections.knowledgeDocuments.findOne({ _id: settledId }))?.status).toBe(
			"ready"
		);
	});
});
