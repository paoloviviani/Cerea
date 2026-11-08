/**
 * A reindex to another embedding model must not leave the old model's vectors
 * to be ranked against the new model's queries, and an ingest that began
 * before a reindex must not write afterwards.
 * Same setup as mrl.spec.ts (TEST_DATABASE_URL, TEST_MONGODB_URL).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { Pool } from "pg";
import { collections, ready } from "$lib/server/database";
import { logger } from "$lib/server/logger";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const { embedMock, getMock } = vi.hoisted(() => ({ embedMock: vi.fn(), getMock: vi.fn() }));

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
vi.mock("$lib/server/gatewayServer", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/gatewayServer")>()),
	gateway: { get: getMock },
}));

/** 384 wide, the same for both models: the case where old and new vectors are comparable by width. */
const vec = (seed: number) => Array.from({ length: 384 }, (_, i) => ((seed + i) % 10) / 10 + 0.05);

describe.skipIf(!TEST_DATABASE_URL)("reindex vectors", () => {
	let pg: Pool;
	let svc: typeof import("./service");
	let toUuid: typeof import("./db").toUuid;
	const dbName = `cerea_reindex_${process.pid}`;
	const owner = { userId: new ObjectId(), email: "o@example.org", groups: [], isAdmin: false };

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
		({ toUuid } = await import("./db"));
		const { ensureSchema } = await import("./db");
		await ensureSchema();
		vi.spyOn(logger, "warn").mockImplementation(() => undefined as never);
	}, 60_000);

	afterAll(async () => {
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
		getMock.mockReset();
		getMock.mockResolvedValue({
			data: ["model-a", "model-b"].map((id) => ({ id, kind: "embedding" })),
		});
		await collections.vectorStores.deleteMany({});
		await collections.knowledgeDocuments.deleteMany({});
		await collections.knowledgeConfig.deleteMany({});
		await collections.knowledgeConfig.insertOne({
			enabled: true,
			embeddingModel: "model-a",
			chunkChars: 1200,
			chunkOverlap: 150,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		await pg.query("DELETE FROM knowledge_chunks");
	});

	const chunkDocs = async (storeId: string) =>
		(
			await pg.query<{ document_id: string }>(
				"SELECT DISTINCT document_id FROM knowledge_chunks WHERE store_id = $1",
				[toUuid(storeId)]
			)
		).rows.length;

	async function settled(storeId: string) {
		await vi.waitFor(
			async () => {
				const open = await collections.knowledgeDocuments.countDocuments({
					storeId: new ObjectId(storeId),
					status: "pending",
				});
				const base = await collections.vectorStores.findOne({ _id: new ObjectId(storeId) });
				expect(open).toBe(0);
				expect(base?.reindexingSince ?? null).toBeNull();
			},
			{ timeout: 10_000 }
		);
	}

	it("returns no old-model vectors when one document fails on the new model", async () => {
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[]) =>
			texts.map(() => vec(1))
		);
		const made = await svc.createStore(owner, { name: "s" }, "tok");
		await svc.addText(made.id, owner, "tok", {
			text: "first document text ".repeat(5),
			title: "one",
		});
		await svc.addText(made.id, owner, "tok", {
			text: "second document text ".repeat(5),
			title: "two",
		});
		expect(await chunkDocs(made.id)).toBe(2);

		// On the new model the second document is refused; the first embeds.
		embedMock.mockImplementation(async (_t: string, model: string, texts: string[]) => {
			if (model === "model-b" && texts[0].startsWith("second")) throw new Error("refused");
			return texts.map(() => vec(model === "model-b" ? 7 : 1));
		});
		await svc.reindex(made.id, owner, "tok", { embeddingModel: "model-b" });
		await settled(made.id);

		// Only the document that embedded with model B has vectors: nothing from A.
		expect(await chunkDocs(made.id)).toBe(1);
		const hits = await svc.search(made.id, owner, "tok", { query: "first" });
		expect(hits.data).toHaveLength(1);
		expect(hits.data[0]?.title).toBe("one");
		expect(embedMock.mock.calls.at(-1)?.[1]).toBe("model-b");
	});

	it("drops a write from an ingest that began before a reindex moved the base on", async () => {
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[]) =>
			texts.map(() => vec(1))
		);
		const made = await svc.createStore(owner, { name: "s" }, "tok");
		const doc = await svc.addText(made.id, owner, "tok", {
			text: "some document text ".repeat(5),
			title: "d",
		});
		let release!: () => void;
		const gate = new Promise<void>((resolve) => (release = resolve));
		embedMock.mockImplementation(async (_t: string, _m: string, texts: string[]) => {
			await gate;
			return texts.map(() => vec(3));
		});
		embedMock.mockClear();
		const stale = svc.ingestDocument(new ObjectId(doc.id), "tok");
		// A reindex lands while that embed is in flight.
		await vi.waitFor(() => expect(embedMock).toHaveBeenCalled());
		await collections.vectorStores.updateOne(
			{ _id: new ObjectId(made.id) },
			{ $inc: { embeddingGeneration: 1 } }
		);
		await pg.query("DELETE FROM knowledge_chunks");
		release();
		await stale;
		expect(await chunkDocs(made.id)).toBe(0);
	});
});
