import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { cleanStoredTitles } from "./cleanStoredTitles";

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.conversations.deleteMany({});
});

async function chat(title: string, userText: string, titleSource?: string) {
	const _id = new ObjectId();
	const t = new Date();
	await collections.conversations.insertOne({
		_id,
		title,
		...(titleSource ? { titleSource } : {}),
		rootMessageId: "s",
		model: "m",
		messages: [
			{
				id: "s",
				from: "system",
				content: "",
				createdAt: t,
				updatedAt: t,
				children: [],
				ancestors: [],
			},
			{
				id: "u",
				from: "user",
				content: userText,
				createdAt: t,
				updatedAt: t,
				children: [],
				ancestors: [],
			},
		],
		createdAt: t,
		updatedAt: t,
		sessionId: "x",
	} as never);
	return _id;
}
const titleOf = async (id: ObjectId) =>
	(await collections.conversations.findOne({ _id: id }))?.title;

describe("cleaning stored titles", () => {
	it("repairs tokens, refusals and wrong-language titles, and only those", async () => {
		const token = await chat(
			"<|start|>assistant<|channel|>",
			"Plan a team offsite in Lisbon",
			"model"
		);
		const tokenPlus = await chat(
			"<|start|>Team offsite plan<|end|>",
			"Plan a team offsite",
			"model"
		);
		const refusal = await chat(
			"I'm unable to execute code or generate",
			"Run this script for me",
			"model"
		);
		const wrong = await chat(
			"Come scegliere la migliore app per le note",
			"What is the best note taking app for me",
			"model"
		);
		const good = await chat(
			"Quota policy recommendation",
			"Recommend a quota policy for us",
			"model"
		);
		const userNamed = await chat("<|start|>mine", "Hello there friend", "user");
		const legacyOwn = await chat("Confronto app", "What is the best note taking app for me");
		expect(await cleanStoredTitles(collections)).toBe(4);
		expect(await titleOf(token)).toBe("Plan a team offsite in Lisbon");
		expect(await titleOf(tokenPlus)).toBe("Team offsite plan");
		expect(await titleOf(refusal)).toBe("Run this script for me");
		expect(await titleOf(wrong)).toBe("What is the best note taking…");
		expect(await titleOf(good)).toBe("Quota policy recommendation");
		expect(await titleOf(userNamed)).toBe("<|start|>mine");
		expect(await titleOf(legacyOwn)).toBe("Confronto app");
	});
});
