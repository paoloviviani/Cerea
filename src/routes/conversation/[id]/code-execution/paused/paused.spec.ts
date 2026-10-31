import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/server/api/__tests__/testHelpers";
import { codePausedWaitMs } from "$lib/server/codeExecution/deadlines";
import { POST } from "./+server";

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await cleanupTestData();
	await collections.parkedCalls.deleteMany({});
});

const ID = "66666666-6666-4666-8666-666666666666";

async function parked() {
	const { locals } = await createTestUser();
	const conv = await createTestConversation(locals);
	const soon = new Date(Date.now() + 5_000);
	await collections.parkedCalls.insertOne({
		_id: new ObjectId(),
		parkedCallId: ID,
		conversationId: conv._id,
		messageId: "msg-1",
		toolCallId: "call-1",
		toolUuid: "uuid-1",
		kind: "code",
		status: "waiting",
		resumeAt: soon,
		reason: "code execution in the person's browser",
		code: "print(1)",
		attempts: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return { locals, conv, soon };
}

const call = async (locals: App.Locals, id: string, body: unknown) => {
	try {
		const res = await POST({
			params: { id },
			locals,
			request: new Request("http://localhost/x", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		} as never);
		return res.status;
	} catch (e) {
		return (e as { status?: number }).status;
	}
};

describe.sequential("POST /conversation/[id]/code-execution/paused", () => {
	it("extends the owner's pending call by the configured wait", async () => {
		const { locals, conv, soon } = await parked();
		expect(await call(locals, conv._id.toString(), { executionId: ID })).toBe(200);
		const row = await collections.parkedCalls.findOne({ parkedCallId: ID });
		expect(row?.resumeAt.getTime()).toBeGreaterThan(soon.getTime());
		expect(row?.resumeAt.getTime()).toBeLessThanOrEqual(Date.now() + codePausedWaitMs());
	});

	it("ignores a wait sent by the client", async () => {
		const { locals, conv } = await parked();
		await call(locals, conv._id.toString(), { executionId: ID, waitMs: 99_999_999_999 });
		const row = await collections.parkedCalls.findOne({ parkedCallId: ID });
		expect(row?.resumeAt.getTime()).toBeLessThanOrEqual(Date.now() + codePausedWaitMs());
	});

	it("refuses another user's conversation and leaves the deadline alone", async () => {
		const { conv, soon } = await parked();
		const { locals: other } = await createTestUser();
		expect(await call(other, conv._id.toString(), { executionId: ID })).toBe(404);
		const row = await collections.parkedCalls.findOne({ parkedCallId: ID });
		expect(row?.resumeAt.getTime()).toBe(soon.getTime());
	});

	it("refuses an unknown call, a bad body and an answered call", async () => {
		const { locals, conv } = await parked();
		const id = conv._id.toString();
		expect(await call(locals, id, { executionId: "77777777-7777-4777-8777-777777777777" })).toBe(
			404
		);
		expect(await call(locals, id, { executionId: "nope" })).toBe(400);
		await collections.parkedCalls.updateOne(
			{ parkedCallId: ID },
			{ $set: { outcome: { ok: true, stdout: "", stderr: "", files: [] } } }
		);
		expect(await call(locals, id, { executionId: ID })).toBe(409);
	});
});
