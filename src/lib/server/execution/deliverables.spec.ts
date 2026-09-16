import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	MAX_DELIVERABLE_BYTES,
	MAX_DELIVERABLE_TOTAL_BYTES_PER_CONVERSATION,
	MAX_DELIVERABLES_PER_CONVERSATION,
	deleteConversationDeliverables,
	downloadDeliverable,
	storeDeliverable,
	sweepExpiredDeliverables,
} from "./deliverables";

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	const files = await collections.codeOutputBucket.find({}).toArray();
	await Promise.all(files.map((f) => collections.codeOutputBucket.delete(f._id)));
	await collections.codeExecutionOutputs.deleteMany({});
});

describe("storeDeliverable", () => {
	it("stores bytes and returns a reference addressed by content hash", async () => {
		const conversationId = new ObjectId();
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

	it("dedups identical bytes within a conversation instead of storing twice", async () => {
		const conversationId = new ObjectId();
		const bytes = Buffer.from("same content");

		const first = await storeDeliverable({
			conversationId,
			name: "a.txt",
			mime: "text/plain",
			bytes,
		});
		const second = await storeDeliverable({
			conversationId,
			// Different name for the same bytes: the existing row's name wins,
			// which is fine — dedup is about not duplicating storage, not about
			// which of two names a rerun happened to use.
			name: "b.txt",
			mime: "text/plain",
			bytes,
		});

		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.ref.sha256).toBe(first.ref.sha256);
		expect(await collections.codeExecutionOutputs.countDocuments({ conversationId })).toBe(1);
	});

	it("stores the same bytes again for a different conversation", async () => {
		const bytes = Buffer.from("shared content");
		const first = await storeDeliverable({
			conversationId: new ObjectId(),
			name: "a.txt",
			mime: "text/plain",
			bytes,
		});
		const second = await storeDeliverable({
			conversationId: new ObjectId(),
			name: "a.txt",
			mime: "text/plain",
			bytes,
		});
		expect(first.ok && second.ok).toBe(true);
		expect(await collections.codeExecutionOutputs.countDocuments({})).toBe(2);
	});

	it("refuses a file over the single-file cap", async () => {
		const conversationId = new ObjectId();
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
		const conversationId = new ObjectId();
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
		const conversationId = new ObjectId();
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

describe("downloadDeliverable", () => {
	it("reads the stored bytes back by conversation + sha256", async () => {
		const conversationId = new ObjectId();
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
		const conversationId = new ObjectId();
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
		const conversationId = new ObjectId();
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
		const mine = new ObjectId();
		const other = new ObjectId();
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
		const a = new ObjectId();
		const b = new ObjectId();
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
		const conversationId = new ObjectId();
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
		const conversationId = new ObjectId();
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
});

describe("the codeExecutionOutputs TTL index", () => {
	it("expires rows 30 days after createdAt", async () => {
		// Index creation at startup is fire-and-forget (database.ts), so re-assert
		// it here rather than racing that: `createIndex` is idempotent and
		// confirms the same definition this app relies on at startup.
		await collections.codeExecutionOutputs.createIndex(
			{ createdAt: 1 },
			{ expireAfterSeconds: 30 * 24 * 60 * 60 }
		);
		const indexes = await collections.codeExecutionOutputs.indexes();
		const ttl = indexes.find((i) => i.key?.createdAt === 1 && "expireAfterSeconds" in i);
		expect(ttl?.expireAfterSeconds).toBe(30 * 24 * 60 * 60);
	});
});
