/**
 * A rename through either PATCH route goes through applyConversationSettings;
 * it marks the title as the user's, and a title generation that finishes
 * afterwards must not overwrite it. Against the real database.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import { cleanupTestData } from "$lib/server/api/__tests__/testHelpers";
import { applyConversationSettings, saveGeneratedTitle } from "./conversationSettings";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(cleanupTestData);

async function newChat(extra: Record<string, unknown> = {}) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		title: "New Chat",
		model: "m",
		messages: [],
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	} as never);
	return _id;
}

describe("title source", () => {
	it("a rename sets titleSource user", async () => {
		const _id = await newChat({ title: "first words", titleSource: "fallback", titleAttempts: 1 });
		await applyConversationSettings({ _id }, { title: "  My own name " });
		const doc = await collections.conversations.findOne({ _id });
		expect(doc).toMatchObject({ title: "My own name", titleSource: "user" });
	});

	it("a generated title is saved with its source and attempts", async () => {
		const _id = await newChat();
		await saveGeneratedTitle(_id, { title: "Python", titleSource: "model", titleAttempts: 1 });
		expect(await collections.conversations.findOne({ _id })).toMatchObject({
			title: "Python",
			titleSource: "model",
			titleAttempts: 1,
		});
	});

	it("a title generation finishing after a rename does not overwrite it", async () => {
		const _id = await newChat({ titleSource: "fallback", titleAttempts: 1 });
		await applyConversationSettings({ _id }, { title: "Renamed" });
		await saveGeneratedTitle(_id, { title: "Model title", titleSource: "model", titleAttempts: 2 });
		expect(await collections.conversations.findOne({ _id })).toMatchObject({
			title: "Renamed",
			titleSource: "user",
			titleAttempts: 1,
		});
	});
});
