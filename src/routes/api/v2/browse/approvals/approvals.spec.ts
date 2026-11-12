/** The Needs-you inbox's browse source: the caller's own pending approvals, nothing else. */
import { beforeEach, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { GET } from "./+server";

await ready;

const owner = new ObjectId();
const stranger = new ObjectId();

async function conversation(userId: ObjectId, title: string) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		userId,
		title,
		messages: [],
		model: "m",
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id;
}

async function ask(conversationId: ObjectId, over: Record<string, unknown> = {}) {
	const elicitationId = crypto.randomUUID();
	await collections.mcpElicitations.insertOne({
		_id: new ObjectId(),
		elicitationId,
		conversationId,
		status: "pending",
		request: {
			elicitationId,
			server: "browser_act",
			mode: "form",
			message: "Click",
			browse: { sentence: 'Click "Pay" on shop.example.com', site: "shop.example.com" },
		},
		expiresAt: new Date(Date.now() + 60_000),
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	} as never);
	return elicitationId;
}

const call = (user: ObjectId | null) =>
	GET({ locals: user ? { user: { _id: user }, sessionId: "s" } : {} } as never);

beforeEach(async () => {
	await collections.mcpElicitations.deleteMany({});
});

describe("GET /api/v2/browse/approvals", () => {
	it("lists the user's pending browse approvals with their chat", async () => {
		const mine = await conversation(owner, "Shoes");
		const id = await ask(mine);
		const body = await (await call(owner)).json();
		expect(body.approvals).toHaveLength(1);
		expect(body.approvals[0]).toMatchObject({
			elicitationId: id,
			conversationId: mine.toString(),
			conversationTitle: "Shoes",
			request: { browse: { site: "shop.example.com" } },
		});
	});

	it("does not list another user's, an answered, an expired, or a non-browse ask", async () => {
		const mine = await conversation(owner, "Mine");
		const theirs = await conversation(stranger, "Theirs");
		await ask(theirs);
		await ask(mine, { status: "resolved" });
		await ask(mine, { expiresAt: new Date(Date.now() - 1000) });
		const plain = await ask(mine);
		await collections.mcpElicitations.updateOne(
			{ elicitationId: plain },
			{ $unset: { "request.browse": "" } }
		);
		expect((await (await call(owner)).json()).approvals).toEqual([]);
	});

	it("needs a sign-in", async () => {
		await expect(call(null)).rejects.toMatchObject({ status: 401 });
	});
});
