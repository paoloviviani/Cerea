/**
 * A file a privacy rule withheld (extraction answered 403 "Refused by the
 * privacy rule ...") is stored and visible to its owner, but unreachable from
 * every path that would hand its bytes or text to the model or the sandbox.
 * Real bucket; the gateway call is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const { extractMock } = vi.hoisted(() => ({ extractMock: vi.fn() }));
vi.mock("$lib/server/files/extractDocument", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./extractDocument")>();
	return { ...actual, extractDocument: extractMock };
});

import { collections, ready } from "$lib/server/database";
import type { Conversation } from "$lib/types/Conversation";
import type { MessageFile } from "$lib/types/Message";
import { downloadFile, openFile } from "./downloadFile";
import { uploadFile } from "./uploadFile";
import {
	readAttachment,
	findAttachments,
	openAttachment,
	storeAttachment,
} from "./attachmentStore";
import { deleteConversationAttachments } from "./deleteConversationAttachments";
import { resolveHashFiles } from "./resolveHashFiles";
import { findConversationFile } from "$lib/server/textGeneration/builtinTools/conversationFiles";
import { promptAttachments } from "$lib/server/code/promptAttachments";
import { planAttachments } from "$lib/utils/execution/attachmentNames";

const PDF = () =>
	new File([Buffer.from("%PDF-1.4 secret words")], "secret.pdf", { type: "application/pdf" });
const REFUSED = {
	ok: false,
	kind: "refused",
	status: 403,
	reason: "Withheld by the privacy rule 'no-health' (pipeline 'strict').",
	withheld: { rule: "no-health", pipeline: "strict" },
};

const conversations: ObjectId[] = [];
const ownerKeys: string[] = [];

beforeAll(async () => {
	await ready;
});
afterAll(async () => {
	for (const id of conversations) {
		await deleteConversationAttachments(id);
		await collections.conversations.deleteOne({ _id: id });
	}
});

async function conversationWith(files: MessageFile[]): Promise<Conversation> {
	const _id = new ObjectId();
	conversations.push(_id);
	const conv = {
		_id,
		messages: [{ id: "m1", from: "user", content: "read it", files, createdAt: new Date() }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as unknown as Conversation;
	await collections.conversations.insertOne(conv as never);
	return conv;
}

describe("a privacy-withheld upload", () => {
	it("records the rule on the MessageFile and keeps the file stored", async () => {
		extractMock.mockResolvedValueOnce(REFUSED);
		const conv = await conversationWith([]);
		const file = await uploadFile(PDF(), conv, "t");
		expect(file.withheld).toEqual({ rule: "no-health", pipeline: "strict" });
		expect(file.extracted).toBeUndefined();
	});

	it("is unreachable through downloadFile, openFile, the owner-keyed store and re-extraction", async () => {
		extractMock.mockResolvedValueOnce(REFUSED);
		const conv = await conversationWith([]);
		const file = await uploadFile(PDF(), conv, "t");
		await expect(downloadFile(file.value, conv._id)).rejects.toMatchObject({ status: 403 });
		await expect(openFile(file.value, conv._id)).rejects.toMatchObject({ status: 403 });
		await expect(downloadFile(file.value, conv._id)).rejects.toMatchObject({
			body: { message: expect.stringContaining("withheld by the privacy rule 'no-health'") },
		});

		// The owner-keyed (coding agent) store.
		const key = `code:dev${new ObjectId().toString()}:sess`;
		ownerKeys.push(key);
		extractMock.mockResolvedValueOnce(REFUSED);
		const stored = await storeAttachment(PDF(), key, "msg1", "t");
		expect(stored.withheld).toBeDefined();
		await expect(readAttachment(stored.value, key)).rejects.toMatchObject({ status: 403 });
		await expect(openAttachment(stored.value, key)).rejects.toMatchObject({ status: 403 });
		const found = await findAttachments(key, "msg1");
		expect(found[0].withheld).toEqual({ rule: "no-health", pipeline: "strict" });
		// Agent attachments: a notice, never the bytes.
		const [attachment] = await promptAttachments(key, "msg1");
		const body = Buffer.from(attachment.url.split(",")[1], "base64").toString("utf-8");
		expect(body).toContain("withheld by the privacy rule 'no-health'");
		expect(body).not.toContain("secret words");
		expect(attachment.mime).toBe("text/plain");

		// Re-extraction of a resent reference is never attempted.
		extractMock.mockClear();
		const conv2 = await conversationWith([file]);
		const [again] = await resolveHashFiles(
			[{ type: "hash", value: file.value, mime: file.mime, name: file.name }],
			conv2,
			"t"
		);
		expect(again.withheld).toBeDefined();
		expect(extractMock).not.toHaveBeenCalled();
	});

	it("is never planned for mounting in the sandbox", () => {
		const plan = planAttachments([
			{
				type: "hash",
				value: "h",
				name: "secret.pdf",
				mime: "application/pdf",
				withheld: { rule: "r" },
			},
			{ type: "hash", value: "k", name: "ok.txt", mime: "text/plain" },
		]);
		expect(plan.map((p) => p.name)).toEqual(["ok.txt"]);
	});

	it("is refused by the document tools (doc_outline and the rest) with the privacy reason", async () => {
		extractMock.mockResolvedValueOnce(REFUSED);
		const conv = await conversationWith([]);
		const file = await uploadFile(PDF(), conv, "t");
		await collections.conversations.updateOne(
			{ _id: conv._id },
			{ $set: { "messages.0.files": [file] } }
		);
		const found = await findConversationFile(conv._id, "secret.pdf");
		expect(found).toMatchObject({ ok: false });
		expect((found as { error: string }).error).toContain(
			"withheld by the privacy rule 'no-health'"
		);
	});
});

describe("a technical read failure", () => {
	it("keeps today's behaviour: no withheld mark, bytes still readable", async () => {
		extractMock.mockResolvedValueOnce({
			ok: false,
			kind: "unreachable",
			status: 502,
			reason: "The document reader could not be reached.",
		});
		const conv = await conversationWith([]);
		const file = await uploadFile(PDF(), conv, "t");
		expect(file.withheld).toBeUndefined();
		expect(file.extractionError?.kind).toBe("unreachable");
		const bytes = await downloadFile(file.value, conv._id);
		expect(Buffer.from(bytes.value, "base64").toString()).toContain("secret words");
	});
});
