/**
 * Which file a name stands for when an attachment and a produced file share it, and which
 * version of a produced file is the newest: the real conversation and deliverable stores.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	deleteConversationDeliverables,
	storeDeliverable,
} from "$lib/server/execution/deliverables";
import { putBlob } from "$lib/server/blobs/testing";
import { findConversationFile } from "./conversationFiles";
import { resolveFileReferences } from "../mcp/fileReferences";

beforeAll(async () => {
	await ready;
});

let conversations: ObjectId[] = [];
afterEach(async () => {
	await deleteConversationDeliverables(conversations);
	await collections.conversations.deleteMany({ _id: { $in: conversations } });
	conversations = [];
});

const ATTACHED = "the user's attachment, 96,733 bytes in real life";

async function setup() {
	const conversationId = new ObjectId();
	conversations.push(conversationId);
	const sha = createHash("sha256").update(ATTACHED).digest("hex");
	await putBlob(
		`${conversationId}-${sha}`,
		{ conversation: conversationId.toString(), mime: "image/svg+xml" },
		ATTACHED
	);
	await collections.conversations.insertOne({
		_id: conversationId,
		title: "t",
		model: "m",
		messages: [
			{
				id: "m1",
				from: "user",
				content: "commit these",
				createdAt: new Date(Date.now() - 60_000),
				files: [{ type: "hash", name: "arch.svg", value: sha, mime: "image/svg+xml" }],
			},
		],
		createdAt: new Date(Date.now() - 120_000),
		updatedAt: new Date(),
		sessionId: "s",
	} as never);
	return conversationId;
}

const produce = (conversationId: ObjectId, text: string) =>
	storeDeliverable({
		conversationId,
		name: "arch.svg",
		mime: "image/svg+xml",
		bytes: Buffer.from(text),
		tool: "sandbox",
	});

describe("file sources", () => {
	it("an attachment and a produced file with one name are told apart by source", async () => {
		const id = await setup();
		await produce(id, "the model's own SVG");
		const data = await findConversationFile(id, "arch.svg", { source: "attachment" });
		expect(data.ok && data.bytes.toString()).toBe(ATTACHED);
		const out = await findConversationFile(id, "arch.svg", { source: "output" });
		expect(out.ok && out.bytes.toString()).toBe("the model's own SVG");
	});

	it("a produced file rewritten later resolves to its newest bytes, not the first", async () => {
		const id = await setup();
		await produce(id, "version one");
		await produce(id, "version two");
		await produce(id, "version three, the newest");
		const out = await findConversationFile(id, "arch.svg", { source: "output" });
		expect(out.ok && out.bytes.toString()).toBe("version three, the newest");
		expect(out.ok && out.version).toBeGreaterThan(2);
		// Through a reference, with the real lookup.
		const r = await resolveFileReferences(
			{ c: { $file: "/mnt/output/arch.svg" } },
			{
				conversationId: id,
			}
		);
		expect(r).toMatchObject({ ok: true, args: { c: "version three, the newest" } });
	});

	it("refuses a source that has no such file", async () => {
		const id = await setup();
		const none = await findConversationFile(id, "arch.svg", { source: "output" });
		expect(none.ok).toBe(false);
		const other = await findConversationFile(id, "nope.svg", { source: "attachment" });
		expect(other.ok).toBe(false);
	});

	it("a bare name two files share is refused with both paths; explicit paths each resolve", async () => {
		const id = await setup();
		await produce(id, "the model's own SVG");
		const bare = await resolveFileReferences({ c: { $file: "arch.svg" } }, { conversationId: id });
		expect(bare.ok).toBe(false);
		if (!bare.ok) {
			expect(bare.error).toContain("/mnt/data/arch.svg");
			expect(bare.error).toContain("/mnt/output/arch.svg");
		}
		const data = await resolveFileReferences(
			{ c: { $file: "/mnt/data/arch.svg" } },
			{ conversationId: id }
		);
		expect(data).toMatchObject({ ok: true, args: { c: ATTACHED } });
		expect(data.ok && data.notes[0]).toContain("/mnt/data/arch.svg (attachment,");
	});
});
