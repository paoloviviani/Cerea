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

async function ask(
	conversationId: ObjectId,
	userId: ObjectId | undefined,
	over: Record<string, unknown> = {},
	screenshot?: { mime: string; base64: string }
) {
	const elicitationId = crypto.randomUUID();
	await collections.mcpElicitations.insertOne({
		_id: new ObjectId(),
		elicitationId,
		conversationId,
		...(userId ? { userId } : {}),
		status: "pending",
		request: {
			elicitationId,
			server: "browser_act",
			mode: "form",
			message: "Click",
			browse: {
				sentence: 'Click "Pay" on shop.example.com',
				site: "shop.example.com",
				...(screenshot ? { screenshot } : {}),
			},
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
		const id = await ask(mine, owner);
		const body = await (await call(owner)).json();
		expect(body.approvals).toHaveLength(1);
		expect(body.approvals[0]).toMatchObject({
			elicitationId: id,
			conversationId: mine.toString(),
			conversationTitle: "Shoes",
			request: { browse: { site: "shop.example.com" } },
		});
	});

	it("does not list another user's, an answered, an expired, a non-browse or an ownerless ask", async () => {
		const mine = await conversation(owner, "Mine");
		const theirs = await conversation(stranger, "Theirs");
		await ask(theirs, stranger);
		// Their ask, pointing at my conversation: the row's own user decides, not the chat id.
		await ask(mine, stranger);
		await ask(mine, owner, { status: "resolved" });
		await ask(mine, owner, { expiresAt: new Date(Date.now() - 1000) });
		await ask(mine, undefined);
		const plain = await ask(mine, owner);
		await collections.mcpElicitations.updateOne(
			{ elicitationId: plain },
			{ $unset: { "request.browse": "" } }
		);
		expect((await (await call(owner)).json()).approvals).toEqual([]);
	});

	it("leaves out a picture larger than a thumbnail, and keeps a small one", async () => {
		const mine = await conversation(owner, "Mine");
		await ask(mine, owner, {}, { mime: "image/png", base64: "A".repeat(120_000) });
		await ask(mine, owner, {}, { mime: "image/png", base64: "AAAA" });
		const { approvals } = await (await call(owner)).json();
		const shots = approvals.map(
			(a: { request: { browse: { screenshot?: unknown } } }) => a.request.browse.screenshot
		);
		expect(shots.filter(Boolean)).toHaveLength(1);
		expect(JSON.stringify(approvals)).not.toContain("A".repeat(1000));
	});

	it("caps the list", async () => {
		const mine = await conversation(owner, "Mine");
		for (let i = 0; i < 60; i += 1) await ask(mine, owner);
		expect((await (await call(owner)).json()).approvals).toHaveLength(50);
	});

	it("needs a sign-in", async () => {
		await expect(call(null)).rejects.toMatchObject({ status: 401 });
	});
});
