/**
 * User memory: stored whole and injected whole, never searched.
 *
 * Pins the store rules the routes and the `remember`/`forget` tools share —
 * validation, deduplication, the fact ceiling, owner isolation — and the
 * prompt block's shape: oldest-first rendering, oldest dropped first past the
 * character budget, with a notice when that happens.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { MEMORY_BLOCK_MAX_CHARS, MEMORY_MAX_FACTS } from "$lib/types/Memory";
import { fitMemoriesToBudget } from "$lib/utils/memoryBudget";
import {
	buildMemoryBlock,
	deleteMemory,
	forgetFact,
	listMemories,
	memoryContext,
	MemoryValidationError,
	rememberFact,
	updateMemory,
} from "./service";

beforeAll(async () => {
	await ready;
}, 30000);

const owner = new ObjectId();
const other = new ObjectId();

beforeEach(async () => {
	// Scoped to this file's owners: sibling spec files share the same test
	// database and a blanket delete would wipe a concurrently running file's
	// rows mid-test.
	await collections.memories.deleteMany({ userId: { $in: [owner, other] } });
}, 20000);

async function seed(text: string, userId = owner, source: "user" | "model" = "user") {
	return rememberFact({ userId, text, source });
}

describe("rememberFact", () => {
	it("stores a fact, trimmed and with collapsed whitespace", async () => {
		const { memory, created } = await seed("  Prefers   concise  answers. ");
		expect(created).toBe(true);
		expect(memory.text).toBe("Prefers concise answers.");
		expect(memory.userId).toStrictEqual(owner);
		expect(memory.source).toBe("user");
	});

	it("rejects an empty fact and stores nothing", async () => {
		await expect(seed("   ")).rejects.toBeInstanceOf(MemoryValidationError);
		expect(await collections.memories.countDocuments({ userId: owner })).toBe(0);
	});

	it("rejects a fact past the per-fact cap", async () => {
		await expect(seed("x".repeat(401))).rejects.toThrow("characters or fewer");
		expect(await collections.memories.countDocuments({ userId: owner })).toBe(0);
	});

	it("recognises a duplicate and returns it without a second row", async () => {
		const first = await seed("Prefers concise answers.");
		const second = await seed("  prefers  CONCISE answers ");
		expect(second.created).toBe(false);
		expect(second.memory._id).toStrictEqual(first.memory._id);
		expect(second.memory.updatedAt.getTime()).toBeGreaterThanOrEqual(
			first.memory.updatedAt.getTime()
		);
		expect(await collections.memories.countDocuments({ userId: owner })).toBe(1);
	});

	it("treats a trailing full stop as the same fact, not a new one", async () => {
		await seed("Speaks Italian");
		const { created } = await seed("Speaks Italian.");
		expect(created).toBe(false);
		expect(await collections.memories.countDocuments({ userId: owner })).toBe(1);
	});

	it("refuses a write past the fact ceiling", async () => {
		const now = new Date();
		await collections.memories.insertMany(
			Array.from({ length: MEMORY_MAX_FACTS }, (_, index) => ({
				_id: new ObjectId(),
				userId: owner,
				text: `Seeded fact ${index}.`,
				source: "user" as const,
				createdAt: now,
				updatedAt: now,
			}))
		);
		await expect(seed("One fact too many.")).rejects.toThrow(
			`Memory is full (${MEMORY_MAX_FACTS} facts)`
		);
	});
});

describe("updateMemory and deleteMemory", () => {
	it("rewrites a fact in place", async () => {
		const { memory } = await seed("Speaks Italian.");
		const updated = await updateMemory(owner, memory._id, "Speaks French.");
		expect(updated.text).toBe("Speaks French.");
		expect(updated._id).toStrictEqual(memory._id);
	});

	it("answers a miss — and another person's row — as not found", async () => {
		await expect(updateMemory(owner, new ObjectId(), "New text.")).rejects.toThrow(
			"No such memory."
		);
		const { memory } = await seed("Private fact.", other);
		await expect(updateMemory(owner, memory._id, "Rewritten.")).rejects.toThrow("No such memory.");
		expect((await listMemories(other)).map((row) => row.text)).toEqual(["Private fact."]);
	});

	it("deletes an owned row and reports a miss as false", async () => {
		const { memory } = await seed("Temporary fact.");
		expect(await deleteMemory(owner, memory._id)).toBe(true);
		expect(await deleteMemory(owner, memory._id)).toBe(false);
		const { memory: theirs } = await seed("Theirs.", other);
		expect(await deleteMemory(owner, theirs._id)).toBe(false);
	});
});

describe("forgetFact", () => {
	it("removes an exact match", async () => {
		await seed("Prefers concise answers.");
		const removed = await forgetFact({ userId: owner, text: "Prefers concise answers." });
		expect(removed.text).toBe("Prefers concise answers.");
		expect(await listMemories(owner)).toHaveLength(0);
	});

	it("matches past case, spacing and a trailing full stop", async () => {
		await seed("Prefers concise answers.");
		const removed = await forgetFact({ userId: owner, text: "  PREFERS   concise answers " });
		expect(removed.text).toBe("Prefers concise answers.");
	});

	it("accepts a unique paraphrase but refuses an ambiguous one", async () => {
		await seed("Prefers concise answers with no preamble.");
		await seed("Speaks Italian.");
		const removed = await forgetFact({ userId: owner, text: "concise answers" });
		expect(removed.text).toBe("Prefers concise answers with no preamble.");
		await seed("Prefers concise answers with no preamble.");
		await seed("Prefers concise answers on Fridays.");
		await expect(forgetFact({ userId: owner, text: "concise" })).rejects.toThrow(
			"more than one memory"
		);
		expect(await listMemories(owner)).toHaveLength(3);
	});

	it("refuses a miss by listing what is actually stored", async () => {
		await seed("Speaks Italian.");
		await expect(forgetFact({ userId: owner, text: "Plays chess." })).rejects.toThrow(
			"Speaks Italian."
		);
	});

	it("says plainly when there is nothing to forget", async () => {
		await expect(forgetFact({ userId: owner, text: "Anything." })).rejects.toThrow(
			"nothing in memory"
		);
	});
});

describe("buildMemoryBlock", () => {
	it("is undefined when there is nothing to say", async () => {
		expect(await buildMemoryBlock(owner)).toBeUndefined();
	});

	it("renders every fact oldest-first under a header naming what they are", async () => {
		await seed("First fact.");
		await seed("Second fact.");
		const block = await buildMemoryBlock(owner);
		expect(block).toContain("standing facts");
		expect(block).toContain("- First fact.\n- Second fact.");
	});

	it("drops the oldest facts past the budget and says how many", async () => {
		// ~130 characters each: twenty of them (well over the 1500-character
		// block budget) cannot all fit, so the oldest must give way.
		for (let index = 0; index < 20; index += 1) {
			await seed(
				`Fact number ${index}, padded out to roughly a hundred characters long. `.repeat(2)
			);
		}
		const block = await buildMemoryBlock(owner);
		expect(block).toBeDefined();
		expect(block).toContain("stored but omitted here for length");
		// The newest survives; the oldest does not.
		expect(block).toContain("Fact number 19");
		expect(block).not.toContain("Fact number 0");
	});
});

describe("memoryContext", () => {
	it("answers an anonymous turn with nothing, without touching the store", async () => {
		expect(await memoryContext(undefined)).toBeUndefined();
	});
});

describe("fitMemoriesToBudget", () => {
	it("includes everything that fits, with nothing omitted", () => {
		expect(fitMemoriesToBudget(["a", "b", "c"], 100)).toEqual({
			included: [0, 1, 2],
			omitted: 0,
		});
	});

	it("drops oldest-first and keeps the newest", () => {
		const texts = ["oldest", "middle", "newest"];
		// Room for two short facts: the oldest is the one left out.
		const { included, omitted } = fitMemoriesToBudget(
			texts,
			"middle".length + 3 + ("newest".length + 3)
		);
		expect(included).toEqual([1, 2]);
		expect(omitted).toBe(1);
	});

	it("always keeps one fact, however long", () => {
		const texts = ["x".repeat(MEMORY_BLOCK_MAX_CHARS + 100)];
		expect(fitMemoriesToBudget(texts)).toEqual({ included: [0], omitted: 0 });
	});

	it("is empty on an empty list", () => {
		expect(fitMemoriesToBudget([])).toEqual({ included: [], omitted: 0 });
	});
});
