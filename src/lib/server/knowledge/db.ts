/**
 * The chat's own Postgres: where passages and vectors live (ADR 0070).
 *
 * A separate database from the gateway's, on the same instance, reached with
 * the chat's own credentials — the store is the chat's, and neither component
 * can read the other's. Only two things belong here: the chunks (text and
 * vector) and the HNSW indexes that rank them. Everything a person can name —
 * bases, documents, their statuses and shares — is in Mongo, because Mongo is
 * where this application's data lives and Postgres should hold nothing that
 * is not a ranking query.
 */
import { Pool, type PoolClient } from "pg";

import { env } from "$env/dynamic/private";
import { logger } from "$lib/server/logger";

let pool: Pool | undefined;
let ensured: Promise<void> | undefined;

/**
 * The widths a base's vectors may have, and therefore the partial HNSW indexes
 * the schema maintains: 384 through 3072 — the widths real embedding models
 * emit (the gateway's migration 0027 made the same list, for the same reason).
 * A base of any other width still works; its queries just fall back to an
 * exact scan.
 *
 * HNSW refuses a `vector` column above 2000 dimensions and the common 3072-
 * dimension model cannot be indexed as `vector` at all, so ranking happens in
 * half precision (`halfvec`) with storage at full precision — the same shape
 * the gateway's store used, for the same measured reasons.
 */
export const INDEXED_DIMENSIONS = [384, 512, 768, 1024, 1536, 3072] as const;

function connectionString(): string {
	const url = env.CHAT_PG_URL;
	if (!url) {
		throw new Error("CHAT_PG_URL is not set; the knowledge store is unavailable");
	}
	return url;
}

/** The pool, created on first use. Tests inject their own via `withClient`. */
export function knowledgePool(): Pool {
	pool ??= new Pool({ connectionString: connectionString(), max: 4 });
	return pool;
}

/**
 * A Mongo id as a Postgres uuid, deterministically.
 *
 * The store's rows carry the ids of Mongo documents (bases, documents) as
 * plain strings; Postgres refuses to cast a 24-hex ObjectId into `uuid`. The
 * conversion pads to 32 hex digits with a fixed suffix and formats — stable,
 * so the same Mongo id always lands on the same uuid and a uuid read back
 * maps to its document by taking the first 24 characters.
 */
export function toUuid(id: string): string {
	const hex = id.replace(/-/g, "");
	if (hex.length !== 24) {
		throw new Error(`not a 24-hex id: ${id}`);
	}
	const padded = hex + "00000000";
	return [
		padded.slice(0, 8),
		padded.slice(8, 12),
		padded.slice(12, 16),
		padded.slice(16, 20),
		padded.slice(20, 32),
	].join("-");
}

/** The inverse: a uuid from the store back to the Mongo id it names. */
export function fromUuid(uuid: string): string {
	return uuid.replace(/-/g, "").slice(0, 24);
}

/** Run `fn` with a client from the pool. */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
	const client = await knowledgePool().connect();
	try {
		return await fn(client);
	} finally {
		client.release();
	}
}

/**
 * Create the tables and indexes if they are missing.
 *
 * Once per process, serialized: two requests bootstrapping concurrently would
 * each see "missing" and race. `CREATE INDEX CONCURRENTLY` cannot run inside a
 * transaction, and these tables start empty, so plain creation is fine.
 */
export async function ensureSchema(): Promise<void> {
	ensured ??= (async () => {
		await withClient(async (client) => {
			await client.query(`CREATE TABLE IF NOT EXISTS knowledge_chunks (
				id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
				store_id      uuid NOT NULL,
				document_id   uuid NOT NULL,
				ordinal       int  NOT NULL,
				text          text NOT NULL,
				token_count   int  NOT NULL DEFAULT 0,
				embedding     vector NOT NULL,
				dimensions    int  NOT NULL
			)`);
			// `vector` with no modifier on purpose: pgvector lets rows of
			// differing widths coexist in one column, and comparing two widths
			// raises rather than mis-ranks — so `dimensions` is a WHERE clause,
			// and the partial halfvec indexes below partition on it. A fixed
			// width would make choosing a different embedding model a schema
			// change; an untyped column makes it a reindex.
			for (const dims of INDEXED_DIMENSIONS) {
				await client.query(`
					CREATE INDEX IF NOT EXISTS ix_knowledge_chunks_hnsw_${dims}
					ON knowledge_chunks
					USING hnsw ((embedding::halfvec(${dims})) halfvec_cosine_ops)
					WHERE dimensions = ${dims}
				`);
			}
		});
		logger.info("knowledge schema ensured");
	})().catch((err) => {
		// Allow a later request to retry: a transient failure at boot must not
		// become a permanent "the schema exists" lie.
		ensured = undefined;
		throw err;
	});
	return ensured;
}
