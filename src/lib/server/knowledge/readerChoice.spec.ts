/**
 * The document reader choice (backlog C97), against a real Postgres and a real Mongo:
 * a base's reader is validated and used for its uploads, and "Re-read with…"
 * reads one file document's stored original again through the ingest queue.
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
import { removeBlobs } from "$lib/server/blobs/testing";

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
	documentMime: (mime: string) => mime,
	isExtractableDocument: (mime: string) => mime === "application/pdf",
	extractDocument: extractMock,
}));
vi.mock("./readers", () => ({
	readerModelsFor: async () => [
		{ id: "markitdown", local: true },
		{ id: "docling", local: true },
		{ id: "mistral-ocr", local: false },
	],
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

describe.skipIf(!TEST_DATABASE_URL)("document reader choice", () => {
	let pg: Pool;
	let svc: typeof import("./service");
	const dbName = `cerea_reader_${process.pid}`;

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
		await removeBlobs({});
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
		await removeBlobs({});
		await removeBlobs({});
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

	const pdf = (owner: ObjectId, name = "scan.pdf") =>
		svc.storeUpload(
			{
				name,
				bytes: Buffer.from(`%PDF-1.4 fake ${name} ${"x".repeat(5000)}`),
				mime: "application/pdf",
			},
			owner
		);

	async function attachPdf(owner: ObjectId, store: ObjectId, name = "scan.pdf") {
		const up = await pdf(owner, name);
		const doc = await svc.attachFile(
			store.toString(),
			caller(owner),
			"tok",
			{ file_id: up.id },
			{ background: true }
		);
		const id = new ObjectId(doc.id);
		await waitFor(
			async () => (await collections.knowledgeDocuments.findOne({ _id: id }))?.status === "ready"
		);
		return id;
	}

	/** Share a base with a user by email, straight onto the row. */
	const share = (storeId: string, principal: string, role: "viewer" | "editor") =>
		collections.vectorStores.updateOne(
			{ _id: new ObjectId(storeId) },
			{ $push: { shares: { kind: "user", principal, role } } }
		);

	const settle = (id: ObjectId, status = "ready") =>
		waitFor(
			async () => (await collections.knowledgeDocuments.findOne({ _id: id }))?.status === status
		);

	describe("a base's reader", () => {
		it("is saved at creation when the user may use it, and shown on the base", async () => {
			const owner = new ObjectId();
			const made = await svc.createStore(caller(owner), { name: "kb", reader_model: "docling" });
			expect(made.reader_model).toBe("docling");
		});

		it('defaults to the deployment\'s: none stored for "" or absent', async () => {
			const owner = new ObjectId();
			const a = await svc.createStore(caller(owner), { name: "a" });
			const b = await svc.createStore(caller(owner), { name: "b", reader_model: "" });
			expect(a.reader_model).toBeNull();
			expect(b.reader_model).toBeNull();
		});

		it("refuses a model the user may not use, at creation and at save (400)", async () => {
			const owner = new ObjectId();
			await expect(
				svc.createStore(caller(owner), { name: "kb", reader_model: "not-mine" })
			).rejects.toMatchObject({ status: 400 });
			const made = await svc.createStore(caller(owner), { name: "kb" });
			await expect(
				svc.updateStoreReader(made.id, caller(owner), "tok", "not-mine")
			).rejects.toMatchObject({ status: 400 });
			expect((await svc.reachableStore(made.id, caller(owner))).readerModel).toBeUndefined();
		});

		it('can be changed by an editor, not by a viewer, and back to the default with ""', async () => {
			const owner = new ObjectId();
			const made = await svc.createStore(caller(owner), { name: "kb" });
			await share(made.id, "ed@example.org", "editor");
			await share(made.id, "view@example.org", "viewer");
			const editor = caller(new ObjectId(), "ed@example.org");
			const viewer = caller(new ObjectId(), "view@example.org");
			const saved = await svc.updateStoreReader(made.id, editor, "tok", "markitdown");
			expect(saved.reader_model).toBe("markitdown");
			await expect(svc.updateStoreReader(made.id, viewer, "tok", "docling")).rejects.toMatchObject({
				status: 404,
			});
			const cleared = await svc.updateStoreReader(made.id, caller(owner), "tok", "");
			expect(cleared.reader_model).toBeNull();
		});

		it("reads new uploads with the base's reader, and leaves existing documents alone", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			await svc.updateStoreReader(store.toString(), caller(owner), "tok", "markitdown");
			const first = await attachPdf(owner, store, "one.pdf");
			expect(extractMock.mock.calls.at(-1)?.[0]).toMatchObject({ readerModel: "markitdown" });
			const before = await collections.knowledgeDocuments.findOne({ _id: first });

			extractMock.mockClear();
			await svc.updateStoreReader(store.toString(), caller(owner), "tok", "docling");
			// Changing it reads nothing again.
			expect(extractMock).not.toHaveBeenCalled();
			await attachPdf(owner, store, "two.pdf");
			expect(extractMock.mock.calls.at(-1)?.[0]).toMatchObject({ readerModel: "docling" });
			const after = await collections.knowledgeDocuments.findOne({ _id: first });
			expect(after?.text).toBe(before?.text);
			expect(after?.indexedAt).toEqual(before?.indexedAt);
		});
	});

	describe("Re-read with…", () => {
		it("reads the stored original with the chosen reader and re-embeds it", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const id = await attachPdf(owner, store);
			const stored = await collections.knowledgeDocuments.findOne({ _id: id });
			expect(stored?.fileId).toBeTruthy();

			extractMock.mockReset();
			extractMock.mockResolvedValue({ ok: true, text: longText("second reading") });
			embedMock.mockClear();
			const returned = await svc.rereadDocument(
				store.toString(),
				id.toString(),
				caller(owner),
				"tok",
				"docling"
			);
			expect(returned.status).toBe("pending");
			await settle(id);
			expect(extractMock).toHaveBeenCalledTimes(1);
			expect(extractMock.mock.calls[0][0]).toMatchObject({ readerModel: "docling" });
			// The bytes passed are the stored original's.
			expect(Buffer.from(extractMock.mock.calls[0][0].bytes).toString()).toContain("%PDF-1.4 fake");
			const row = await collections.knowledgeDocuments.findOne({ _id: id });
			expect(row?.text).toContain("second reading");
			expect(row?.status).toBe("ready");
			expect(embedMock).toHaveBeenCalled();
			expect(await chunksOfStores([store])).toBeGreaterThan(0);
		});

		it("with no reader given, uses the base's own", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			await svc.updateStoreReader(store.toString(), caller(owner), "tok", "markitdown");
			const id = await attachPdf(owner, store);
			extractMock.mockClear();
			await svc.rereadDocument(store.toString(), id.toString(), caller(owner), "tok", "");
			await waitFor(async () => extractMock.mock.calls.length > 0);
			expect(extractMock.mock.calls[0][0]).toMatchObject({ readerModel: "markitdown" });
			await settle(id);
		});

		it("a failure lands on the document row with the reason, and a second click while it runs is a 409", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const id = await attachPdf(owner, store);
			let release!: () => void;
			const gate = new Promise<void>((r) => (release = r));
			extractMock.mockImplementationOnce(async () => {
				await gate;
				return { ok: false, status: 502, reason: "docling is down" };
			});
			await svc.rereadDocument(store.toString(), id.toString(), caller(owner), "tok", "docling");
			await expect(
				svc.rereadDocument(store.toString(), id.toString(), caller(owner), "tok", "docling")
			).rejects.toMatchObject({ status: 409 });
			release();
			await settle(id, "failed");
			const row = await collections.knowledgeDocuments.findOne({ _id: id });
			expect(row?.error).toContain("docling is down");
		});

		it("is for owners and editors: a viewer, or a stranger, is refused (the base is not theirs to edit)", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const id = await attachPdf(owner, store);
			await share(store.toString(), "view@example.org", "viewer");
			await expect(
				svc.rereadDocument(
					store.toString(),
					id.toString(),
					caller(new ObjectId(), "view@example.org"),
					"tok",
					"docling"
				)
			).rejects.toMatchObject({ status: 404 });
			await expect(
				svc.rereadDocument(
					store.toString(),
					id.toString(),
					caller(new ObjectId(), "nobody@example.org"),
					"tok",
					"docling"
				)
			).rejects.toMatchObject({ status: 404 });
			// An editor may.
			await share(store.toString(), "ed@example.org", "editor");
			const ok = await svc.rereadDocument(
				store.toString(),
				id.toString(),
				caller(new ObjectId(), "ed@example.org"),
				"tok",
				"docling"
			);
			expect(ok.status).toBe("pending");
			await settle(id);
		});

		it("refuses a reader the user may not use (400) without touching the document", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const id = await attachPdf(owner, store);
			await expect(
				svc.rereadDocument(store.toString(), id.toString(), caller(owner), "tok", "not-mine")
			).rejects.toMatchObject({ status: 400 });
			expect((await collections.knowledgeDocuments.findOne({ _id: id }))?.status).toBe("ready");
		});

		it("is refused for a text-only document (no stored file)", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const note = await svc.addText(store.toString(), caller(owner), "tok", {
				text: longText("pasted note"),
				title: "note",
			});
			await expect(
				svc.rereadDocument(store.toString(), note.id, caller(owner), "tok", "docling")
			).rejects.toMatchObject({ status: 400 });
			expect(extractMock).not.toHaveBeenCalled();
		});

		it("is refused for a stored plain-text file: nothing there is extracted", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const up = await uploadText(owner, "a text file");
			const doc = await svc.attachFile(store.toString(), caller(owner), "tok", { file_id: up.id });
			expect(doc.file_id).toBeTruthy();
			await expect(
				svc.rereadDocument(store.toString(), doc.id, caller(owner), "tok", "docling")
			).rejects.toMatchObject({ status: 400 });
		});

		it("is scoped to the base: another base's document is a 404", async () => {
			const owner = new ObjectId();
			const a = await makeStore(owner);
			const b = await makeStore(owner);
			const id = await attachPdf(owner, a);
			await expect(
				svc.rereadDocument(b.toString(), id.toString(), caller(owner), "tok", "docling")
			).rejects.toMatchObject({ status: 404 });
		});
	});
});
