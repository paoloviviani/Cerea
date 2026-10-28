/**
 * A model wider than the store indexes, behind a provider that ignores
 * `dimensions` (Cortecs): MRL models are cut client-side, others fail.
 * Same setup as ingestBackground.spec.ts (TEST_DATABASE_URL, TEST_MONGODB_URL).
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
vi.mock("$lib/server/files/extractDocument", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/files/extractDocument")>()),
	resolveExtractorModel: async () => "reader",
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

const norm = (v: number[]) => Math.sqrt(v.reduce((a, x) => a + x * x, 0));

/** A provider that ignores `dimensions`: always `native` wide, never unit length. */
function wide(native: number) {
	return (text: string): number[] =>
		vectorFor(text)
			.concat(vectorFor(text + "x"), vectorFor(text + "y"))
			.concat(Array.from({ length: native }, (_, i) => ((i % 7) + 1) / 3))
			.slice(0, native);
}

describe.skipIf(!TEST_DATABASE_URL)("wide embeddings", () => {
	let pg: Pool;
	let svc: typeof import("./service");
	const dbName = `cerea_mrl_${process.pid}`;
	const caller = (userId: ObjectId) => ({
		userId,
		email: "owner@example.org",
		groups: [],
		isAdmin: false,
	});

	async function indexOne(model: string) {
		await collections.knowledgeConfig.deleteMany({});
		await collections.knowledgeConfig.insertOne({
			enabled: true,
			embeddingModel: model,
			chunkChars: 1200,
			chunkOverlap: 150,
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const owner = new ObjectId();
		const made = await svc.createStore(caller(owner), { name: "store" });
		const up = await svc.storeUpload(
			{
				name: "a.txt",
				bytes: Buffer.from("A sentence about the quarterly plan. ".repeat(10)),
				mime: "text/plain",
			},
			owner
		);
		const doc = await svc.attachFile(made.id, caller(owner), "tok", { file_id: up.id });
		return { owner, storeId: made.id, doc };
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
		vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
	}, 60_000);

	afterAll(async () => {
		await collections.bucket.drop().catch(() => undefined);
		for (const name of ["vectorStores", "knowledgeDocuments", "knowledgeConfig"] as const) {
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
		await collections.vectorStores.deleteMany({});
		await collections.knowledgeDocuments.deleteMany({});
		await collections.bucketFiles.deleteMany({});
		await collections.bucket.drop().catch(() => undefined);
		await pg.query("DELETE FROM knowledge_chunks");
	});

	it("truncates an MRL model's 4096-wide answer to 3072, unit length, for documents and queries", async () => {
		const seen: (number | undefined)[] = [];
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[], dims?: number) => {
			seen.push(dims);
			return texts.map(wide(4096)); // ignores `dims`
		});
		const { owner, storeId, doc } = await indexOne("cortecs/Qwen3-Embedding-8B");
		expect(doc.status).toBe("ready");
		expect(seen).toContain(3072); // `dimensions` is still asked for first

		const rows = await pg.query(
			"SELECT vector_dims(embedding) AS d, embedding::text AS e FROM knowledge_chunks"
		);
		expect(rows.rows.length).toBeGreaterThan(0);
		for (const r of rows.rows) {
			expect(r.d).toBe(3072);
			expect(norm(JSON.parse(r.e))).toBeCloseTo(1, 4);
		}

		const hits = await svc.search(storeId, caller(owner), "tok", {
			query: "A sentence about the quarterly plan.",
		});
		expect(hits.data.length).toBeGreaterThan(0);
		// the query was embedded at the base's width too
		const lastCall = embedMock.mock.calls.at(-1);
		expect(lastCall?.[3]).toBe(3072);
	});

	it("fails a non-MRL model with a message naming the width and the allowlist", async () => {
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[]) =>
			texts.map(wide(4096))
		);
		const { doc } = await indexOne("some-other-embedder");
		expect(doc.status).toBe("failed");
		expect(doc.error).toContain("4096 dimensions");
		expect(doc.error).toContain("qwen3-embedding");
		expect(doc.error).toContain("some-other-embedder");
	});

	it("leaves a provider that honours `dimensions` alone", async () => {
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[], dims?: number) => {
			const full = texts.map(wide(4096));
			return dims ? full.map((v) => v.slice(0, dims)) : full;
		});
		const { doc } = await indexOne("qwen3-embedding-8b");
		expect(doc.status).toBe("ready");
		const rows = await pg.query("SELECT embedding::text AS e FROM knowledge_chunks");
		for (const r of rows.rows) {
			const v = JSON.parse(r.e) as number[];
			expect(v).toHaveLength(3072);
			// untouched: the stub's slice is not unit length, and nothing renormalised it
			expect(norm(v)).toBeGreaterThan(1.5);
		}
	});
});
