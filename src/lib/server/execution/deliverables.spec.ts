import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections, ready, replaceTtlIndex } from "$lib/server/database";
import {
	MAX_DELIVERABLE_BYTES,
	MAX_DELIVERABLE_TOTAL_BYTES_PER_CONVERSATION,
	MAX_DELIVERABLES_PER_CONVERSATION,
	DEFAULT_RETENTION_DAYS,
	deleteConversationDeliverables,
	deliverableStorageSummary,
	downloadDeliverable,
	parseRetentionDays,
	storeDeliverable,
	sweepExpiredDeliverables,
	sweepOrphanedDeliverableBytes,
} from "./deliverables";

// The number `nextVersionNumber` returns is left real; the race tests below
// override it once each, for the moment when a concurrent save's row has landed
// between the read and the insert.
vi.mock("./fileVersions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./fileVersions")>();
	return { ...actual, nextVersionNumber: vi.fn(actual.nextVersionNumber) };
});

beforeAll(async () => {
	await ready;
});

/**
 * Every conversation id a test creates, so afterEach can clean up precisely
 * through the module's own `deleteConversationDeliverables` — never a bare
 * `deleteMany({})`/bucket-wide wipe, which would race another test FILE's
 * in-flight assertions against the same shared Mongo (TEST_MONGODB_URL runs
 * every spec file against one instance).
 */
let createdConversationIds: ObjectId[] = [];
function newConversationId(): ObjectId {
	const id = new ObjectId();
	createdConversationIds.push(id);
	return id;
}

afterEach(async () => {
	await deleteConversationDeliverables(createdConversationIds);
	createdConversationIds = [];
});

describe("storeDeliverable", () => {
	it("stores bytes and returns a reference addressed by content hash", async () => {
		const conversationId = newConversationId();
		const bytes = Buffer.from("hello deliverable");

		const result = await storeDeliverable({
			conversationId,
			name: "out.txt",
			mime: "text/plain",
			bytes,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.ref.name).toBe("out.txt");
		expect(result.ref.size).toBe(bytes.byteLength);
		expect(result.ref.sha256).toMatch(/^[0-9a-f]{64}$/);

		const row = await collections.codeExecutionOutputs.findOne({ conversationId });
		expect(row?.sha256).toBe(result.ref.sha256);
		expect(row?.size).toBe(bytes.byteLength);
	});

	it("dedups identical bytes under the same name, but gives another name its own row", async () => {
		const conversationId = newConversationId();
		const bytes = Buffer.from("same content");
		const save = (name: string) =>
			storeDeliverable({ conversationId, name, mime: "text/plain", bytes });

		const first = await save("a.txt");
		const again = await save("a.txt");
		// Another name for the same bytes is another file with its own versions: its
		// own row, never a's (a restore or an edit of one must not move the other).
		const other = await save("b.txt");

		if (!first.ok || !again.ok || !other.ok) throw new Error("not stored");
		expect(again.existing).toBe(true);
		expect(other.existing).toBeUndefined();
		expect(other.ref.name).toBe("b.txt");
		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(2);
	});

	it("stores the same bytes again for a different conversation", async () => {
		const bytes = Buffer.from("shared content");
		const first = await storeDeliverable({
			conversationId: newConversationId(),
			name: "a.txt",
			mime: "text/plain",
			bytes,
		});
		const second = await storeDeliverable({
			conversationId: newConversationId(),
			name: "a.txt",
			mime: "text/plain",
			bytes,
		});
		expect(first.ok && second.ok).toBe(true);
		expect(await collections.codeExecutionOutputs.countDocuments({})).toBe(2);
	});

	it("refuses a file over the single-file cap", async () => {
		const conversationId = newConversationId();
		const bytes = Buffer.alloc(MAX_DELIVERABLE_BYTES + 1);

		const result = await storeDeliverable({
			conversationId,
			name: "huge.bin",
			mime: "application/octet-stream",
			bytes,
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(0);
	});

	it("refuses past the per-conversation total byte cap", async () => {
		const conversationId = newConversationId();
		// Seed usage right at the ceiling without actually writing gigabytes of
		// bytes: storeDeliverable's cap check reads `size` back from the
		// metadata collection, so a synthetic row with no matching GridFS
		// entry is enough to exercise the guard.
		await collections.codeExecutionOutputs.insertOne({
			_id: new ObjectId(),
			conversationId,
			sha256: "0".repeat(64),
			name: "existing.bin",
			mime: "application/octet-stream",
			size: MAX_DELIVERABLE_TOTAL_BYTES_PER_CONVERSATION,
			gridFsId: new ObjectId(),
			createdAt: new Date(),
		});

		const result = await storeDeliverable({
			conversationId,
			name: "more.txt",
			mime: "text/plain",
			bytes: Buffer.from("a"),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(413);
		expect(result.error).toContain("size limit");
	});

	it("refuses past the per-conversation file count cap", async () => {
		const conversationId = newConversationId();
		const rows = Array.from({ length: MAX_DELIVERABLES_PER_CONVERSATION }, (_, i) => ({
			_id: new ObjectId(),
			conversationId,
			sha256: i.toString().padStart(64, "0"),
			name: `f${i}.txt`,
			mime: "text/plain",
			size: 1,
			gridFsId: new ObjectId(),
			createdAt: new Date(),
		}));
		await collections.codeExecutionOutputs.insertMany(rows);

		const result = await storeDeliverable({
			conversationId,
			name: "one-too-many.txt",
			mime: "text/plain",
			bytes: Buffer.from("x"),
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("limit");
	});
});

describe("a raced version number", () => {
	it("recomputes the number and retries when another save took it", async () => {
		const { nextVersionNumber } = await import("./fileVersions");
		const conversationId = newConversationId();
		// Another writer's row, already stored under this name with version 1.
		await collections.codeExecutionOutputs.insertOne({
			_id: new ObjectId(),
			conversationId,
			sha256: "1".repeat(64),
			name: "race.txt",
			mime: "text/plain",
			size: 1,
			gridFsId: new ObjectId(),
			version: 1,
			createdAt: new Date(),
		});
		// The raced save read its number before that row landed: it says 1,
		// which the unique (conversation, name, version) index refuses.
		vi.mocked(nextVersionNumber).mockImplementationOnce(async () => 1);

		const result = await storeDeliverable({
			conversationId,
			name: "race.txt",
			mime: "text/plain",
			bytes: Buffer.from(`raced-${Math.random()}`),
		});

		expect(result.ok).toBe(true);
		const versions = await collections.codeExecutionOutputs
			.find({ conversationId })
			.project<{ version: number }>({ version: 1 })
			.sort({ version: 1 })
			.toArray();
		expect(versions.map((row) => row.version)).toEqual([1, 2]);
	});

	it("a racing save that stored the same bytes wins: this one reports them stored", async () => {
		const { nextVersionNumber } = await import("./fileVersions");
		const conversationId = newConversationId();
		const bytes = Buffer.from("twin bytes");
		const sha256 = createHash("sha256").update(bytes).digest("hex");
		// The twin row lands between the number read and the insert.
		vi.mocked(nextVersionNumber).mockImplementationOnce(async () => {
			await collections.codeExecutionOutputs.insertOne({
				_id: new ObjectId(),
				conversationId,
				sha256,
				name: "twin.txt",
				mime: "text/plain",
				size: bytes.byteLength,
				gridFsId: new ObjectId(),
				version: 1,
				createdAt: new Date(),
			});
			return 1;
		});

		const result = await storeDeliverable({
			conversationId,
			name: "twin.txt",
			mime: "text/plain",
			bytes,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.existing).toBe(true);
		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(1);
	});
});

describe("downloadDeliverable", () => {
	it("reads the stored bytes back by conversation + sha256", async () => {
		const conversationId = newConversationId();
		const bytes = Buffer.from("round trip me");
		const stored = await storeDeliverable({
			conversationId,
			name: "trip.txt",
			mime: "text/plain",
			bytes,
		});
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;

		const file = await downloadDeliverable(conversationId, stored.ref.sha256);
		expect(file?.buffer.toString()).toBe("round trip me");
		expect(file?.name).toBe("trip.txt");
		expect(file?.mime).toBe("text/plain");
	});

	it("returns undefined for another conversation's sha256 — access is the caller's job, existence is this", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "mine.txt",
			mime: "text/plain",
			bytes: Buffer.from("mine"),
		});
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;

		const file = await downloadDeliverable(new ObjectId(), stored.ref.sha256);
		expect(file).toBeUndefined();
	});

	it("returns undefined for an unknown sha256", async () => {
		const file = await downloadDeliverable(new ObjectId(), "f".repeat(64));
		expect(file).toBeUndefined();
	});
});

describe("deleteConversationDeliverables", () => {
	it("removes both the metadata row and the GridFS bytes", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "gone.txt",
			mime: "text/plain",
			bytes: Buffer.from("delete me"),
		});
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;

		await deleteConversationDeliverables(conversationId);

		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(0);
		expect(await downloadDeliverable(conversationId, stored.ref.sha256)).toBeUndefined();
	});

	it("leaves other conversations' deliverables untouched", async () => {
		const mine = newConversationId();
		const other = newConversationId();
		await storeDeliverable({
			conversationId: mine,
			name: "a.txt",
			mime: "text/plain",
			bytes: Buffer.from("a"),
		});
		const otherStored = await storeDeliverable({
			conversationId: other,
			name: "b.txt",
			mime: "text/plain",
			bytes: Buffer.from("b"),
		});
		expect(otherStored.ok).toBe(true);
		if (!otherStored.ok) return;

		await deleteConversationDeliverables(mine);

		expect(await downloadDeliverable(other, otherStored.ref.sha256)).toBeDefined();
	});

	it("accepts a batch of conversation ids, for bulk conversation deletes", async () => {
		const a = newConversationId();
		const b = newConversationId();
		await storeDeliverable({
			conversationId: a,
			name: "a.txt",
			mime: "text/plain",
			bytes: Buffer.from("a"),
		});
		await storeDeliverable({
			conversationId: b,
			name: "b.txt",
			mime: "text/plain",
			bytes: Buffer.from("b"),
		});

		await deleteConversationDeliverables([a, b]);

		expect(
			await collections.codeExecutionOutputs.countDocuments({ conversationId: { $in: [a, b] } })
		).toBe(0);
	});
});

describe("sweepExpiredDeliverables", () => {
	it("removes a deliverable past the 30-day TTL, bytes included", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "old.txt",
			mime: "text/plain",
			bytes: Buffer.from("stale"),
		});
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;
		await collections.codeExecutionOutputs.updateOne(
			{ conversationId, sha256: stored.ref.sha256 },
			{ $set: { createdAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) } }
		);

		await sweepExpiredDeliverables();

		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(0);
		expect(await downloadDeliverable(conversationId, stored.ref.sha256)).toBeUndefined();
	});

	it("leaves a deliverable inside the retention window alone", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "fresh.txt",
			mime: "text/plain",
			bytes: Buffer.from("fresh"),
		});
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;

		await sweepExpiredDeliverables();

		expect(await downloadDeliverable(conversationId, stored.ref.sha256)).toBeDefined();
	});

	it("expires a restored row from the restore's moment, however young the row is", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "restored-long-ago.txt",
			mime: "text/plain",
			bytes: Buffer.from(`restored-${Math.random()}`),
		});
		expect(stored.ok).toBe(true);
		if (!stored.ok) return;
		await collections.codeExecutionOutputs.updateOne(
			{ conversationId, sha256: stored.ref.sha256 },
			{ $set: { createdAt: new Date(), latestAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000) } }
		);

		await sweepExpiredDeliverables();

		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(0);
	});
});

describe("the sweep's indexes", () => {
	it("latestAt is indexed sparse, and a name's version number is unique", async () => {
		const indexes = await collections.codeExecutionOutputs.indexes();
		const latestAt = indexes.find(
			(index) => JSON.stringify(index.key) === JSON.stringify({ latestAt: 1 })
		);
		expect(latestAt).toMatchObject({ sparse: true });
		const version = indexes.find(
			(index) =>
				JSON.stringify(index.key) === JSON.stringify({ conversationId: 1, name: 1, version: 1 })
		);
		expect(version).toMatchObject({ unique: true });
		expect(version?.partialFilterExpression).toEqual({ version: { $exists: true } });
	});
});

describe("retention is configurable", () => {
	const DAY = 24 * 60 * 60 * 1000;

	async function storeAged(name: string, ageDays: number) {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name,
			mime: "text/plain",
			bytes: Buffer.from(`${name}-${Math.random()}`),
		});
		if (!stored.ok) throw new Error("store failed");
		await collections.codeExecutionOutputs.updateOne(
			{ conversationId, sha256: stored.ref.sha256 },
			{ $set: { createdAt: new Date(Date.now() - ageDays * DAY) } }
		);
		return { conversationId, sha256: stored.ref.sha256 };
	}

	it("reads the setting, and an unreadable value as the default", () => {
		expect(parseRetentionDays(undefined)).toBe(DEFAULT_RETENTION_DAYS);
		expect(parseRetentionDays("")).toBe(DEFAULT_RETENTION_DAYS);
		expect(parseRetentionDays("90")).toBe(90);
		expect(parseRetentionDays("0")).toBe(0);
		expect(parseRetentionDays("-3")).toBe(DEFAULT_RETENTION_DAYS);
		expect(parseRetentionDays("7.5")).toBe(DEFAULT_RETENTION_DAYS);
		expect(parseRetentionDays("forever")).toBe(DEFAULT_RETENTION_DAYS);
		expect(parseRetentionDays("99999")).toBe(DEFAULT_RETENTION_DAYS);
	});

	it("a shorter period removes what it no longer covers, bytes included", async () => {
		const old = await storeAged("ten-days.txt", 10);
		const fresh = await storeAged("two-days.txt", 2);
		await sweepExpiredDeliverables(Date.now(), 7);
		expect(await downloadDeliverable(old.conversationId, old.sha256)).toBeUndefined();
		expect(await downloadDeliverable(fresh.conversationId, fresh.sha256)).toBeDefined();
	});

	it("0 keeps everything, however old", async () => {
		const ancient = await storeAged("ancient.txt", 400);
		expect(await sweepExpiredDeliverables(Date.now(), 0)).toBe(0);
		expect(await downloadDeliverable(ancient.conversationId, ancient.sha256)).toBeDefined();
	});

	it("removes the message records naming expired files with them", async () => {
		const old = await storeAged("named.txt", 40);
		await collections.codeRunFiles.insertOne({
			_id: new ObjectId(),
			conversationId: old.conversationId,
			messageId: "m1",
			runKey: "r1",
			fingerprint: "f1",
			files: [],
			createdAt: new Date(Date.now() - 40 * DAY),
		} as never);
		await sweepExpiredDeliverables(Date.now(), 30);
		expect(
			await collections.codeRunFiles.countDocuments({ conversationId: old.conversationId })
		).toBe(0);
	});

	it("reports what a period would remove before anybody saves it", async () => {
		const conversationIds = [await storeAged("a.txt", 50), await storeAged("b.txt", 5)];
		const summary = await deliverableStorageSummary(30);
		expect(summary.files).toBeGreaterThanOrEqual(2);
		expect(summary.expiring.files).toBeGreaterThanOrEqual(1);
		const forever = await deliverableStorageSummary(0);
		expect(forever.expiring.files).toBe(0);
		expect(conversationIds).toHaveLength(2);
	});
});

describe("orphaned deliverable bytes", () => {
	it("frees GridFS files no metadata row names, once past the grace period", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "orphan.txt",
			mime: "text/plain",
			bytes: Buffer.from(`orphan-${Math.random()}`),
		});
		if (!stored.ok) throw new Error("store failed");
		const row = await collections.codeExecutionOutputs.findOne({
			conversationId,
			sha256: stored.ref.sha256,
		});
		if (!row) throw new Error("no row");
		// What the old TTL index did: the row goes, the bytes stay.
		await collections.codeExecutionOutputs.deleteOne({ _id: row._id });
		expect(await collections.codeOutputBucket.find({ _id: row.gridFsId }).toArray()).toHaveLength(
			1
		);

		// Inside the grace period an upload may still be waiting for its row.
		await sweepOrphanedDeliverableBytes(Date.now());
		expect(await collections.codeOutputBucket.find({ _id: row.gridFsId }).toArray()).toHaveLength(
			1
		);

		await sweepOrphanedDeliverableBytes(Date.now() + 2 * 60 * 60 * 1000);
		expect(await collections.codeOutputBucket.find({ _id: row.gridFsId }).toArray()).toHaveLength(
			0
		);
	});

	it("never frees bytes a row still names", async () => {
		const conversationId = newConversationId();
		const stored = await storeDeliverable({
			conversationId,
			name: "kept.txt",
			mime: "text/plain",
			bytes: Buffer.from(`kept-${Math.random()}`),
		});
		if (!stored.ok) throw new Error("store failed");
		await sweepOrphanedDeliverableBytes(Date.now() + 2 * 60 * 60 * 1000);
		expect(await downloadDeliverable(conversationId, stored.ref.sha256)).toBeDefined();
	});
});

describe("the createdAt indexes are plain, not TTL", () => {
	it("replaces an earlier TTL index with a plain one", async () => {
		// What an existing deployment has: the 30-day TTL this release removes.
		await collections.codeRunFiles.dropIndex("createdAt_1").catch(() => undefined);
		await collections.codeRunFiles.createIndex(
			{ createdAt: 1 },
			{ expireAfterSeconds: 30 * 24 * 60 * 60 }
		);
		await replaceTtlIndex(collections.codeRunFiles, "codeRunFiles");
		const index = (await collections.codeRunFiles.indexes()).find((i) => i.key?.createdAt === 1);
		expect(index).toBeDefined();
		expect(index && "expireAfterSeconds" in index).toBe(false);
	});
});
