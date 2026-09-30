/**
 * The derived-data invariant, against a real Postgres and a real Mongo.
 *
 * Everything that says "gone" here is asserted on the rows themselves — a
 * `SELECT count(*)` on `knowledge_chunks`, not "a search no longer finds it" —
 * because the erasure promise is about the passage text sitting in the table,
 * and retrievability is a weaker claim.
 *
 * Gated on `TEST_DATABASE_URL` (skipped without it), and on `TEST_MONGODB_URL`
 * for the chat's own database. Against the box's throwaway pgvector container
 * (one already running on 127.0.0.1:55442 is reused; the suite makes its own
 * database inside it and never touches the others):
 *
 *   TEST_DATABASE_URL=postgresql://gw:pw@127.0.0.1:55442/gw \
 *   TEST_MONGODB_URL=mongodb://127.0.0.1:8801 \
 *     npx vitest run --project=server --no-file-parallelism \
 *     src/lib/server/knowledge/deleteDerived.spec.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { Pool } from "pg";
import { collections, ready } from "$lib/server/database";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

const { embedMock } = vi.hoisted(() => ({ embedMock: vi.fn() }));

// The store's connection string is read from SvelteKit's private env per
// call; in vitest that is whatever this suite puts in process.env.
// The suite-wide setup mocks this module (Mongo from TEST_MONGODB_URL); this
// repeats that and adds the store's connection string, which the suite only
// knows once its own database exists — hence the getter.
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
	isExtractableDocument: () => false,
	extractDocument: vi.fn(),
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

describe.skipIf(!TEST_DATABASE_URL)("deleteDerived and the knowledge lifecycle", () => {
	let pg: Pool;
	let svc: typeof import("./service");
	let derived: typeof import("./deleteDerived");
	let sweep: typeof import("./orphanSweep");
	const dbName = `cerea_ragcleanup_${process.pid}`;

	const caller = (userId: ObjectId, email = "owner@example.org") => ({
		userId,
		email,
		groups: [],
		isAdmin: false,
	});

	async function chunkCount(where: string, ids: ObjectId[]): Promise<number> {
		const uuids = ids.map((id) => svcToUuid(id));
		const res = await pg.query(`SELECT count(*)::int AS n FROM knowledge_chunks WHERE ${where}`, [
			uuids,
		]);
		return res.rows[0].n;
	}
	const svcToUuid = (id: ObjectId) => {
		const hex = id.toString() + "00000000";
		return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	};
	const chunksOfDocs = (ids: ObjectId[]) => chunkCount("document_id = ANY($1::uuid[])", ids);
	const chunksOfStores = (ids: ObjectId[]) => chunkCount("store_id = ANY($1::uuid[])", ids);

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
		derived = await import("./deleteDerived");
		sweep = await import("./orphanSweep");
		await collections.knowledgeDocuments.createIndex(
			{ storeId: 1, sourceRef: 1 },
			{ unique: true, partialFilterExpression: { sourceRef: { $type: "string" } } }
		);
	}, 60_000);

	afterAll(async () => {
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

	function need<T>(value: T | null | undefined): T {
		if (value === null || value === undefined) throw new Error("expected a value");
		return value;
	}

	const longText = (seed: string) =>
		`${seed}: ` + "A sentence about the quarterly plan and its risks. ".repeat(12);

	async function makeStore(owner: ObjectId) {
		const made = await svc.createStore(caller(owner), { name: "store" });
		return new ObjectId(made.id);
	}

	async function indexTranscript(store: ObjectId, owner: ObjectId, conv: ObjectId, seed: string) {
		await svc.addText(store.toString(), caller(owner), "tok", {
			text: longText(seed),
			title: "chat",
			source_ref: derived.conversationSourceRef(conv),
		});
	}

	async function docFor(store: ObjectId, conv: ObjectId) {
		return collections.knowledgeDocuments.findOne({
			storeId: store,
			sourceRef: derived.conversationSourceRef(conv),
		});
	}

	// -- M1 ---------------------------------------------------------------------

	describe("deleting a conversation (M1)", () => {
		it("removes its transcript's chunks and row in any base, and only its own", async () => {
			const owner = new ObjectId();
			const storeA = await makeStore(owner);
			const storeB = await makeStore(owner);
			const gone = new ObjectId();
			const kept = new ObjectId();
			const keptElsewhere = new ObjectId();
			await indexTranscript(storeA, owner, gone, "gone");
			await indexTranscript(storeA, owner, kept, "kept");
			// The same handle shape in a different base: a conversation's
			// transcript lives in whichever base its project pointed at.
			await indexTranscript(storeB, owner, keptElsewhere, "elsewhere");
			const goneDoc = await docFor(storeA, gone);
			const keptDoc = await docFor(storeA, kept);
			expect(await chunksOfDocs([need(goneDoc)._id])).toBeGreaterThan(0);

			const { deleteConversationStorage } = await import("$lib/server/conversationStorage");
			await deleteConversationStorage(gone);

			expect(await docFor(storeA, gone)).toBeNull();
			expect(await chunksOfDocs([need(goneDoc)._id])).toBe(0);
			expect(await docFor(storeA, kept)).not.toBeNull();
			expect(await chunksOfDocs([need(keptDoc)._id])).toBeGreaterThan(0);
			expect(await docFor(storeB, keptElsewhere)).not.toBeNull();
		});

		it("finds the transcript in a base other than the deleter's own, and handles the bulk form", async () => {
			const projectOwner = new ObjectId();
			const store = await makeStore(projectOwner);
			const a = new ObjectId();
			const b = new ObjectId();
			await indexTranscript(store, projectOwner, a, "a");
			await indexTranscript(store, projectOwner, b, "b");
			const { deleteConversationStorage } = await import("$lib/server/conversationStorage");
			await deleteConversationStorage([a, b]);
			expect(await collections.knowledgeDocuments.countDocuments({ storeId: store })).toBe(0);
			expect(await chunksOfStores([store])).toBe(0);
		});

		it("is a no-op, not an error, when there is nothing indexed", async () => {
			const { deleteConversationStorage } = await import("$lib/server/conversationStorage");
			await expect(deleteConversationStorage(new ObjectId())).resolves.toBeUndefined();
		});
	});

	// -- the function -------------------------------------------------------------

	describe("deleteDerived", () => {
		it("is idempotent: twice is the same as once", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const conv = new ObjectId();
			await indexTranscript(store, owner, conv, "x");
			await derived.deleteDerived({ conversationId: conv });
			await expect(derived.deleteDerived({ conversationId: conv })).resolves.toEqual({
				documents: 0,
				files: 0,
			});
			await expect(
				derived.deleteDerived({ storeIds: store, dropStores: true })
			).resolves.toBeDefined();
			await expect(
				derived.deleteDerived({ storeIds: store, dropStores: true })
			).resolves.toBeDefined();
		});

		it("deletes chunks before it deletes rows: a failure leaves the rows to retry from", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const conv = new ObjectId();
			await indexTranscript(store, owner, conv, "y");
			const doc = need(await docFor(store, conv));
			const spy = vi.spyOn(collections.bucket, "delete");
			await collections.knowledgeDocuments.updateOne(
				{ _id: doc._id },
				{ $set: { fileId: new ObjectId() } }
			);
			spy.mockRejectedValueOnce(new Error("disk on fire"));
			await expect(derived.deleteDerived({ documentIds: doc._id })).rejects.toThrow("disk on fire");
			spy.mockRestore();
			// The passages are gone (nothing retrievable), the row remains (findable).
			expect(await chunksOfDocs([doc._id])).toBe(0);
			expect(await collections.knowledgeDocuments.countDocuments({ _id: doc._id })).toBe(1);
			// And the retry finishes it.
			await derived.deleteDerived({ documentIds: doc._id });
			expect(await collections.knowledgeDocuments.countDocuments({ _id: doc._id })).toBe(0);
		});

		it("deleting a document or a base removes the GridFS bytes too (L5)", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const up1 = await svc.storeUpload(
				{ name: "a.txt", bytes: Buffer.from(longText("file one")), mime: "text/plain" },
				owner
			);
			const up2 = await svc.storeUpload(
				{ name: "b.txt", bytes: Buffer.from(longText("file two")), mime: "text/plain" },
				owner
			);
			const d1 = await svc.attachFile(store.toString(), caller(owner), "tok", { file_id: up1.id });
			await svc.attachFile(store.toString(), caller(owner), "tok", { file_id: up2.id });
			expect(d1.status).toBe("ready");
			const fileCount = () => collections.bucketFiles.countDocuments({});
			expect(await fileCount()).toBe(2);

			await svc.deleteDocument(store.toString(), d1.id, caller(owner));
			expect(await fileCount()).toBe(1);
			expect(await chunksOfDocs([new ObjectId(d1.id)])).toBe(0);

			await svc.deleteStore(store.toString(), caller(owner));
			expect(await fileCount()).toBe(0);
			expect(await chunksOfStores([store])).toBe(0);
			expect(await collections.vectorStores.countDocuments({ _id: store })).toBe(0);
		});

		it("keeps a file another document still points at", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const up = await svc.storeUpload(
				{ name: "a.txt", bytes: Buffer.from(longText("shared bytes")), mime: "text/plain" },
				owner
			);
			const d = await svc.attachFile(store.toString(), caller(owner), "tok", { file_id: up.id });
			const now = new Date();
			const twin = new ObjectId();
			await collections.knowledgeDocuments.insertOne({
				_id: twin,
				storeId: store,
				fileId: new ObjectId(up.id),
				title: "twin",
				chars: 0,
				chunkCount: 0,
				status: "ready",
				error: "",
				embeddingModel: null,
				indexedAt: null,
				createdAt: now,
				updatedAt: now,
			});
			await derived.deleteDerived({ documentIds: new ObjectId(d.id) });
			expect(await collections.bucketFiles.countDocuments({ _id: new ObjectId(up.id) })).toBe(1);
		});
	});

	// -- M2 -----------------------------------------------------------------------

	describe("erasing an account (M2)", () => {
		it("leaves zero chunk rows for the erased person's stores, and only theirs", async () => {
			const { runErasure } = await import("$lib/server/identity/erasure");
			const person = new ObjectId();
			const other = new ObjectId();
			await collections.users.insertOne({
				_id: person,
				gatewayUserId: "gw-person",
				username: "p",
				name: "p",
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
			const mine1 = await makeStore(person);
			const mine2 = await makeStore(person);
			const theirs = await makeStore(other);
			const conv = new ObjectId();
			await indexTranscript(mine1, person, conv, "mine");
			await indexTranscript(mine2, person, new ObjectId(), "mine too");
			await indexTranscript(theirs, other, new ObjectId(), "theirs");
			const up = await svc.storeUpload(
				{ name: "p.txt", bytes: Buffer.from(longText("private file")), mime: "text/plain" },
				person
			);
			await svc.attachFile(mine1.toString(), caller(person), "tok", { file_id: up.id });
			expect(await chunksOfStores([mine1, mine2])).toBeGreaterThan(0);

			const result = await runErasure("erase-1", "gw-person", []);

			expect(await chunksOfStores([mine1, mine2])).toBe(0);
			expect(
				await collections.knowledgeDocuments.countDocuments({ storeId: { $in: [mine1, mine2] } })
			).toBe(0);
			expect(await collections.vectorStores.countDocuments({ ownerId: person })).toBe(0);
			expect(await collections.bucketFiles.countDocuments({})).toBe(0);
			expect(await chunksOfStores([theirs])).toBeGreaterThan(0);
			// The registry's own counts still say what went.
			expect(result.counts.vectorStores).toBe(2);
			expect(result.counts.knowledgeDocuments).toBeGreaterThanOrEqual(3);
		});

		it("also removes their conversations' transcripts from a base somebody else owns", async () => {
			const { runErasure } = await import("$lib/server/identity/erasure");
			const person = new ObjectId();
			const owner = new ObjectId();
			await collections.users.insertOne({
				_id: person,
				gatewayUserId: "gw-member",
				username: "m",
				name: "m",
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
			const conv = new ObjectId();
			await collections.conversations.insertOne({
				_id: conv,
				userId: person,
				title: "t",
				model: "m",
				messages: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
			const shared = await makeStore(owner);
			await indexTranscript(shared, owner, conv, "member words");
			const ownerConv = new ObjectId();
			await indexTranscript(shared, owner, ownerConv, "owner words");
			await runErasure("erase-2", "gw-member", []);
			expect(await docFor(shared, conv)).toBeNull();
			expect(await docFor(shared, ownerConv)).not.toBeNull();
			const remaining = need(await docFor(shared, ownerConv))._id;
			expect(await chunksOfDocs([remaining])).toBeGreaterThan(0);
		});
	});

	// -- L6, L7, L8 ---------------------------------------------------------------

	describe("re-indexing (L6, L7)", () => {
		it("keeps the old chunks when the new embedding fails (L6)", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const conv = new ObjectId();
			await indexTranscript(store, owner, conv, "before");
			const doc = need(await docFor(store, conv));
			const before = await chunksOfDocs([doc._id]);
			expect(before).toBeGreaterThan(0);

			embedMock.mockRejectedValue(new Error("embedding provider down"));
			await svc.addText(store.toString(), caller(owner), "tok", {
				text: longText("after"),
				title: "chat",
				source_ref: derived.conversationSourceRef(conv),
			});

			expect(need(await docFor(store, conv)).status).toBe("failed");
			expect(await chunksOfDocs([doc._id])).toBe(before);
			const old = await pg.query("SELECT text FROM knowledge_chunks WHERE document_id = $1", [
				svcToUuid(doc._id),
			]);
			expect(old.rows[0].text).toContain("before");
		});

		it("replacing with empty text clears the old passages", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const conv = new ObjectId();
			await indexTranscript(store, owner, conv, "full");
			const doc = need(await docFor(store, conv));
			await svc.addText(store.toString(), caller(owner), "tok", {
				text: "   ",
				source_ref: derived.conversationSourceRef(conv),
			});
			expect(await chunksOfDocs([doc._id])).toBe(0);
		});

		it("two concurrent indexings of one conversation leave one transcript (L7)", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const conv = new ObjectId();
			const text = longText("race");
			const go = () =>
				svc.addText(store.toString(), caller(owner), "tok", {
					text,
					title: "chat",
					source_ref: derived.conversationSourceRef(conv),
				});
			await indexTranscript(new ObjectId(), owner, new ObjectId(), "warm").catch(() => undefined);
			await Promise.all([go(), go(), go()]);
			const docs = await collections.knowledgeDocuments
				.find({ storeId: store, sourceRef: derived.conversationSourceRef(conv) })
				.toArray();
			expect(docs).toHaveLength(1);
			const single = await (async () => {
				const s2 = await makeStore(owner);
				await svc.addText(s2.toString(), caller(owner), "tok", {
					text,
					source_ref: derived.conversationSourceRef(conv),
				});
				return chunksOfStores([s2]);
			})();
			expect(await chunksOfDocs([docs[0]._id])).toBe(single);
		});
	});

	describe("the same file twice (L8)", () => {
		it("dedups by content within a base, and not across bases", async () => {
			const owner = new ObjectId();
			const storeA = await makeStore(owner);
			const storeB = await makeStore(owner);
			const bytes = Buffer.from(longText("same file"));
			const upload = () => svc.storeUpload({ name: "r.txt", bytes, mime: "text/plain" }, owner);
			const first = await svc.attachFile(storeA.toString(), caller(owner), "tok", {
				file_id: (await upload()).id,
			});
			const again = await svc.attachFile(storeA.toString(), caller(owner), "tok", {
				file_id: (await upload()).id,
			});
			expect(again.id).toBe(first.id);
			expect(await collections.knowledgeDocuments.countDocuments({ storeId: storeA })).toBe(1);
			// The redundant upload did not linger.
			expect(await collections.bucketFiles.countDocuments({})).toBe(1);
			const inB = await svc.attachFile(storeB.toString(), caller(owner), "tok", {
				file_id: (await upload()).id,
			});
			expect(inB.id).not.toBe(first.id);
		});
	});

	// -- the sweep ----------------------------------------------------------------

	describe("the orphan sweep", () => {
		it("removes seeded orphans and leaves everything live alone", async () => {
			const owner = new ObjectId();
			const store = await makeStore(owner);
			const liveConv = new ObjectId();
			const deadConv = new ObjectId();
			await collections.conversations.insertOne({
				_id: liveConv,
				userId: owner,
				title: "live",
				model: "m",
				messages: [],
				createdAt: new Date(),
				updatedAt: new Date(),
			} as never);
			await indexTranscript(store, owner, liveConv, "live");
			await indexTranscript(store, owner, deadConv, "dead");
			const liveDoc = need(await docFor(store, liveConv));
			const deadDoc = need(await docFor(store, deadConv));

			// Chunks whose document, and whose whole store, no longer exist.
			const ghostDoc = new ObjectId();
			const ghostStore = new ObjectId();
			for (const [s, d] of [
				[store, ghostDoc],
				[ghostStore, new ObjectId()],
			] as const) {
				await pg.query(
					`INSERT INTO knowledge_chunks (store_id, document_id, ordinal, text, embedding, dimensions)
					 VALUES ($1, $2, 0, 'leaked passage', $3::vector, 384)`,
					[svcToUuid(s), svcToUuid(d), `[${vectorFor("x").join(",")}]`]
				);
			}

			// An unattached upload, a knowledge file with a document, and an attachment.
			const orphanUp = await svc.storeUpload(
				{ name: "o.txt", bytes: Buffer.from("orphan"), mime: "text/plain" },
				owner
			);
			const liveUp = await svc.storeUpload(
				{ name: "l.txt", bytes: Buffer.from(longText("attached")), mime: "text/plain" },
				owner
			);
			await svc.attachFile(store.toString(), caller(owner), "tok", { file_id: liveUp.id });
			const attachment = new ObjectId();
			await new Promise<void>((resolve, reject) => {
				const up = collections.bucket.openUploadStreamWithId(attachment, "conv-abc", {
					metadata: { conversation: liveConv.toString() },
				});
				up.once("finish", () => resolve());
				up.once("error", reject);
				up.end(Buffer.from("attachment"));
			});

			// Inside the grace period nothing is an orphan upload yet.
			const early = await sweep.sweepKnowledgeOrphans();
			expect(early.orphanFiles).toBe(0);
			expect(early.orphanTranscripts).toBe(1);
			// The ghost store's chunk names a document that does not exist either.
			expect(early.orphanChunkDocuments).toBe(2);
			expect(early.orphanChunkStores).toBe(1);
			expect(await collections.bucketFiles.countDocuments({ _id: new ObjectId(orphanUp.id) })).toBe(
				1
			);

			const late = await sweep.sweepKnowledgeOrphans(new Date(Date.now() + 3 * 86_400_000));
			expect(late.orphanFiles).toBe(1);
			expect(await collections.bucketFiles.countDocuments({ _id: new ObjectId(orphanUp.id) })).toBe(
				0
			);
			expect(await collections.bucketFiles.countDocuments({ _id: new ObjectId(liveUp.id) })).toBe(
				1
			);
			expect(await collections.bucketFiles.countDocuments({ _id: attachment })).toBe(1);

			expect(await collections.knowledgeDocuments.countDocuments({ _id: deadDoc._id })).toBe(0);
			expect(await chunksOfDocs([deadDoc._id, ghostDoc])).toBe(0);
			expect(await chunksOfStores([ghostStore])).toBe(0);
			expect(await chunksOfDocs([liveDoc._id])).toBeGreaterThan(0);

			// A second pass finds nothing.
			const again = await sweep.sweepKnowledgeOrphans(new Date(Date.now() + 3 * 86_400_000));
			expect(again).toEqual({
				orphanChunkDocuments: 0,
				orphanChunkStores: 0,
				orphanFiles: 0,
				orphanTranscripts: 0,
			});
		});
	});

	// -- shared project memory (L2) and its failures (L9) --------------------------

	describe("a shared project's memory (L2, L9)", () => {
		async function setup() {
			const ownerId = new ObjectId();
			const memberId = new ObjectId();
			const now = new Date();
			const project = {
				_id: new ObjectId(),
				userId: ownerId,
				name: "Shared",
				description: "",
				instructions: "",
				knowledgeBaseIds: [],
				indexPastChats: true,
				retrievalLimit: 6,
				shares: [{ kind: "user", email: "member@example.org", createdAt: now }],
				createdAt: now,
				updatedAt: now,
			};
			await collections.projects.insertOne(project as never);
			const memberLocals = {
				user: { _id: memberId, email: "member@example.org" },
				token: "member-token",
			} as unknown as App.Locals;
			const ownerLocals = {
				user: { _id: ownerId, email: "owner@example.org" },
				token: "owner-token",
			} as unknown as App.Locals;
			return { ownerId, memberId, project, memberLocals, ownerLocals };
		}
		const convOf = (id: ObjectId, userId: ObjectId, projectId: ObjectId) =>
			({ _id: id, userId, projectId, title: "Budget talk" }) as never;
		const talk = [
			{ from: "user", content: "What is the plan for the quarterly budget review?" },
			{ from: "assistant", content: "The plan is to review the quarterly budget in March." },
		] as never;

		it("indexes a member's conversation into a base the project's owner owns, retrievable by another member", async () => {
			const { indexConversation, projectContext } = await import("$lib/server/projects");
			const { ownerId, memberId, project, memberLocals, ownerLocals } = await setup();
			const conv = new ObjectId();
			await indexConversation({
				project: project as never,
				conversation: convOf(conv, memberId, project._id),
				messages: talk,
				token: "member-token",
				locals: memberLocals,
			});
			const stored = need(await collections.projects.findOne({ _id: project._id }));
			expect(stored.memoryBaseId).toBeDefined();
			const base = need(
				await collections.vectorStores.findOne({ _id: new ObjectId(stored.memoryBaseId) })
			);
			expect(base.ownerId.equals(ownerId)).toBe(true);
			expect(base.shares).toEqual([]);
			expect(await docFor(base._id, conv)).not.toBeNull();

			// The owner reads what the member said; the member reads it too.
			for (const locals of [ownerLocals, memberLocals]) {
				const context = await projectContext({
					project: stored,
					question: "quarterly budget review",
					token: locals.token,
					locals,
				});
				expect(context).toContain("quarterly budget");
			}
		});

		it("replaces a legacy member-owned base with one the project's owner owns, and stops writing to it", async () => {
			const { indexConversation } = await import("$lib/server/projects");
			const { ownerId, memberId, project, memberLocals } = await setup();
			// Made before the base belonged to the project: the first speaker owns it.
			const legacy = await makeStore(memberId);
			await collections.projects.updateOne(
				{ _id: project._id },
				{ $set: { memoryBaseId: legacy.toString() } }
			);
			const stored = need(await collections.projects.findOne({ _id: project._id }));
			const conv = new ObjectId();
			await indexConversation({
				project: stored,
				conversation: convOf(conv, memberId, project._id),
				messages: talk,
				token: "t",
				locals: memberLocals,
			});
			const after = need(await collections.projects.findOne({ _id: project._id }));
			expect(after.memoryBaseId).not.toBe(legacy.toString());
			const fresh = need(
				await collections.vectorStores.findOne({ _id: new ObjectId(after.memoryBaseId) })
			);
			expect(fresh.ownerId.equals(ownerId)).toBe(true);
			expect(await docFor(fresh._id, conv)).not.toBeNull();
			expect(await collections.knowledgeDocuments.countDocuments({ storeId: legacy })).toBe(0);
			expect(await chunksOfStores([legacy])).toBe(0);
		});

		it("creates one base when two members finish a first turn together", async () => {
			const { indexConversation } = await import("$lib/server/projects");
			const { memberId, project, memberLocals, ownerLocals, ownerId } = await setup();
			await Promise.all([
				indexConversation({
					project: project as never,
					conversation: convOf(new ObjectId(), memberId, project._id),
					messages: talk,
					token: "t",
					locals: memberLocals,
				}),
				indexConversation({
					project: project as never,
					conversation: convOf(new ObjectId(), ownerId, project._id),
					messages: talk,
					token: "t",
					locals: ownerLocals,
				}),
			]);
			const stored = need(await collections.projects.findOne({ _id: project._id }));
			const bases = await collections.vectorStores.find({}).toArray();
			expect(bases.map((b) => b._id.toString())).toEqual([stored.memoryBaseId]);
		});

		it("puts a failed write on the base's document list (L9)", async () => {
			const { indexConversation } = await import("$lib/server/projects");
			const { memberId, project, memberLocals } = await setup();
			await indexConversation({
				project: project as never,
				conversation: convOf(new ObjectId(), memberId, project._id),
				messages: talk,
				token: "t",
				locals: memberLocals,
			});
			const stored = need(await collections.projects.findOne({ _id: project._id }));
			// The deployment loses its embedding model; the next turn cannot be indexed.
			await collections.knowledgeConfig.updateMany({}, { $set: { embeddingModel: null } });
			const conv = new ObjectId();
			await collections.conversations.insertOne(
				convOf(conv, memberId, project._id) as unknown as never
			);
			const gone = new ObjectId();
			for (const id of [conv, gone]) {
				await indexConversation({
					project: stored,
					conversation: convOf(id, memberId, project._id),
					messages: talk,
					token: "t",
					locals: memberLocals,
				});
			}
			// A conversation deleted mid-index gets no row, let alone one with its title.
			expect(await docFor(new ObjectId(stored.memoryBaseId), gone)).toBeNull();
			const row = await docFor(new ObjectId(stored.memoryBaseId), conv);
			expect(row?.status).toBe("failed");
			expect(row?.error).toMatch(/embedding model/);
		});
	});

	// -- L1 -----------------------------------------------------------------------

	describe("deleting a project (L1)", () => {
		async function projectWithMemory() {
			const { indexConversation } = await import("$lib/server/projects");
			const ownerId = new ObjectId();
			const now = new Date();
			const project = {
				_id: new ObjectId(),
				userId: ownerId,
				name: "Doomed",
				description: "",
				instructions: "",
				knowledgeBaseIds: [],
				indexPastChats: true,
				retrievalLimit: 6,
				shares: [],
				createdAt: now,
				updatedAt: now,
			};
			await collections.projects.insertOne(project as never);
			const locals = {
				user: { _id: ownerId, email: "owner@example.org" },
			} as unknown as App.Locals;
			await indexConversation({
				project: project as never,
				conversation: {
					_id: new ObjectId(),
					userId: ownerId,
					projectId: project._id,
					title: "t",
				} as never,
				messages: [
					{ from: "user", content: "What is the plan for the quarterly budget review?" },
					{ from: "assistant", content: "The plan is to review the quarterly budget in March." },
				] as never,
				token: "t",
				locals,
			});
			const stored = need(await collections.projects.findOne({ _id: project._id }));
			return { project, locals, baseId: new ObjectId(stored.memoryBaseId) };
		}

		it("keeps the memory base by default and drops it, chunks and all, when asked", async () => {
			const { DELETE } = await import("../../../routes/api/v2/projects/[id]/+server");
			for (const [query, survives] of [
				["", true],
				["?memory=delete", false],
			] as const) {
				const { project, locals, baseId } = await projectWithMemory();
				await DELETE({
					locals,
					params: { id: project._id.toString() },
					url: new URL(`http://localhost/${query}`),
				} as never);
				expect(await collections.projects.countDocuments({ _id: project._id })).toBe(0);
				expect(await collections.vectorStores.countDocuments({ _id: baseId })).toBe(
					survives ? 1 : 0
				);
				expect((await chunksOfStores([baseId])) > 0).toBe(survives);
			}
		});
	});
});
