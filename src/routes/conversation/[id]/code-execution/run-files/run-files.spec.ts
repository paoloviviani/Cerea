/**
 * Every produced file is kept the same way (the user's rule, 2026-09-26): a
 * chat code block's and an artifact cell's files go to the same store an
 * `execute_code` run uses, and this route records which message they belong
 * to. These pin what that record may claim, who may make it, and that the
 * conversation loader serves it back on the right message.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/server/api/__tests__/testHelpers";
import { withRunFiles } from "$lib/server/execution/runFiles";
import { deleteConversationDeliverables } from "$lib/server/execution/deliverables";
import { MessageCodeExecutionUpdateType, MessageUpdateType } from "$lib/types/MessageUpdate";
import type { Message } from "$lib/types/Message";

import { POST as upload } from "../output/+server";
import { POST as record } from "./+server";

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await cleanupTestData();
	await collections.codeRunFiles.deleteMany({});
	await collections.codeExecutionOutputs.deleteMany({});
});

const assistant: Message = {
	id: "asst-1",
	from: "assistant",
	content: "Here is your file",
	updates: [],
	ancestors: [],
	children: [],
} as unknown as Message;

async function ownerWithConversation() {
	const { locals } = await createTestUser();
	const conv = await createTestConversation(locals);
	await collections.conversations.updateOne(
		{ _id: conv._id },
		{ $set: { messages: [{ ...assistant, updates: [] }] } }
	);
	return { locals, conv };
}

async function uploadFile(
	locals: App.Locals,
	conversationId: ObjectId,
	name: string,
	content: string
) {
	const form = new FormData();
	form.append("file", new Blob([content]), name);
	const res = await upload({
		params: { id: conversationId.toString() },
		locals,
		request: new Request("http://localhost/x", { method: "POST", body: form }),
	} as never);
	const body = (await res.json()) as { files: { name: string; size: number; sha256: string }[] };
	return body.files[0];
}

function recordRequest(body: unknown) {
	return new Request("http://localhost/x", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe.sequential("POST /conversation/[id]/code-execution/run-files", () => {
	it("records a code block's uploaded file on its message, rebuilt from the store", async () => {
		const { locals, conv } = await ownerWithConversation();
		const stored = await uploadFile(locals, conv._id, "hello_world.docx", "docx bytes");

		const res = await record({
			params: { id: conv._id.toString() },
			locals,
			request: recordRequest({ messageId: "asst-1", runKey: "chat:abc", sha256: [stored.sha256] }),
		} as never);

		expect(res.status).toBe(200);
		const rows = await collections.codeRunFiles.find({ conversationId: conv._id }).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ messageId: "asst-1", runKey: "chat:abc" });
		// Name and size come from the store row, never from the request.
		expect(rows[0].files).toEqual([
			{ name: "hello_world.docx", size: stored.size, sha256: stored.sha256 },
		]);
	});

	it("records a run once however many times it is posted", async () => {
		const { locals, conv } = await ownerWithConversation();
		const stored = await uploadFile(locals, conv._id, "a.pdf", "pdf");
		const body = { messageId: "asst-1", runKey: "chat:abc", sha256: [stored.sha256] };

		await Promise.all(
			[1, 2, 3].map(() =>
				record({
					params: { id: conv._id.toString() },
					locals,
					request: recordRequest(body),
				} as never)
			)
		);

		expect(await collections.codeRunFiles.countDocuments({ conversationId: conv._id })).toBe(1);
	});

	it("refuses a hash this conversation never stored", async () => {
		const { locals, conv } = await ownerWithConversation();

		await expect(
			record({
				params: { id: conv._id.toString() },
				locals,
				request: recordRequest({
					messageId: "asst-1",
					runKey: "chat:abc",
					sha256: ["f".repeat(64)],
				}),
			} as never)
		).rejects.toMatchObject({ status: 400 });
		expect(await collections.codeRunFiles.countDocuments({})).toBe(0);
	});

	it("refuses somebody else's conversation, including a file stored there", async () => {
		const { locals: owner, conv } = await ownerWithConversation();
		const stored = await uploadFile(owner, conv._id, "a.pdf", "pdf");
		const { locals: stranger } = await createTestUser();

		await expect(
			record({
				params: { id: conv._id.toString() },
				locals: stranger,
				request: recordRequest({
					messageId: "asst-1",
					runKey: "chat:abc",
					sha256: [stored.sha256],
				}),
			} as never)
		).rejects.toMatchObject({ status: 404 });
		expect(await collections.codeRunFiles.countDocuments({})).toBe(0);
	});

	it("refuses to attach files to a user message", async () => {
		const { locals, conv } = await ownerWithConversation();
		await collections.conversations.updateOne(
			{ _id: conv._id },
			{ $push: { messages: { ...assistant, id: "user-1", from: "user" } } as never }
		);
		const stored = await uploadFile(locals, conv._id, "a.pdf", "pdf");

		await expect(
			record({
				params: { id: conv._id.toString() },
				locals,
				request: recordRequest({
					messageId: "user-1",
					runKey: "chat:abc",
					sha256: [stored.sha256],
				}),
			} as never)
		).rejects.toMatchObject({ status: 400 });
	});
});

describe.sequential("serving and deleting a conversation's run files", () => {
	it("serves a record on its message as an Outputs update, and nowhere else", async () => {
		const { locals, conv } = await ownerWithConversation();
		const stored = await uploadFile(locals, conv._id, "a.pdf", "pdf");
		await record({
			params: { id: conv._id.toString() },
			locals,
			request: recordRequest({ messageId: "asst-1", runKey: "chat:abc", sha256: [stored.sha256] }),
		} as never);

		const other = { ...assistant, id: "asst-2", updates: [] } as Message;
		const served = await withRunFiles(conv._id, [{ ...assistant, updates: [] }, other]);

		expect(served[0].updates).toEqual([
			{
				type: MessageUpdateType.CodeExecution,
				subtype: MessageCodeExecutionUpdateType.Outputs,
				runKey: "chat:abc",
				files: [{ name: "a.pdf", size: stored.size, sha256: stored.sha256 }],
			},
		]);
		expect(served[1]).toBe(other);
	});

	it("deletes the records with the conversation's files", async () => {
		const { locals, conv } = await ownerWithConversation();
		const stored = await uploadFile(locals, conv._id, "a.pdf", "pdf");
		await record({
			params: { id: conv._id.toString() },
			locals,
			request: recordRequest({ messageId: "asst-1", runKey: "chat:abc", sha256: [stored.sha256] }),
		} as never);

		await deleteConversationDeliverables(conv._id);

		expect(await collections.codeRunFiles.countDocuments({ conversationId: conv._id })).toBe(0);
		expect(
			await collections.codeExecutionOutputs.countDocuments({ conversationId: conv._id })
		).toBe(0);
	});
});
