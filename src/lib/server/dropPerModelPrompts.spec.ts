import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { dropPerModelPrompts } from "./dropPerModelPrompts";

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await collections.settings.deleteMany({});
});

describe("dropPerModelPrompts", () => {
	it("unsets the retired per-model prompts and leaves everything else, and is idempotent", async () => {
		const stale = new ObjectId();
		const clean = new ObjectId();
		await collections.settings.insertMany([
			{
				_id: stale,
				userId: new ObjectId(),
				activeModel: "m",
				globalSystemPrompt: "keep me",
				customPrompts: { m: "stale" },
				customPromptsEnabled: { m: true },
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				_id: clean,
				userId: new ObjectId(),
				activeModel: "m",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		] as never);

		expect(await dropPerModelPrompts(collections.settings)).toBe(1);
		const row = (await collections.settings.findOne({ _id: stale })) as Record<string, unknown>;
		expect(row).not.toHaveProperty("customPrompts");
		expect(row).not.toHaveProperty("customPromptsEnabled");
		expect(row.globalSystemPrompt).toBe("keep me");
		expect(row.activeModel).toBe("m");

		expect(await dropPerModelPrompts(collections.settings)).toBe(0);
	});
});
