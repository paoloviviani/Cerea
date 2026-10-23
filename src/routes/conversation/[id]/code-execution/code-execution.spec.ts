/* eslint-disable @typescript-eslint/no-non-null-assertion -- assertions on values the test just created */
/**
 * The `execute_code` outcome POST records what the run produced whether or
 * not the browser's upload worked: a failed save must leave a record that says
 * so (`uploaded: false`), not vanish after a reload.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/server/api/__tests__/testHelpers";
import { buildCodeExecutionResolvedUpdate } from "$lib/server/textGeneration/builtinTools/executeCodeTool";

vi.mock("$lib/server/generation/parkedSweeper", () => ({
	sweepParkedCalls: vi.fn(async () => undefined),
}));

import { POST as upload } from "./output/+server";
import { POST } from "./+server";

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await cleanupTestData();
	await collections.parkedCalls.deleteMany({});
	await collections.codeExecutionOutputs.deleteMany({});
});

const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";

async function parkedRun() {
	const { locals } = await createTestUser();
	const conv = await createTestConversation(locals);
	await collections.parkedCalls.insertOne({
		_id: new ObjectId(),
		parkedCallId: EXECUTION_ID,
		conversationId: conv._id,
		messageId: "msg-1",
		toolCallId: "call-1",
		toolUuid: "uuid-1",
		kind: "code",
		status: "waiting",
		resumeAt: new Date(Date.now() + 60_000),
		reason: "code execution in the person's browser",
		code: "print('hi')",
		attempts: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return { locals, conv };
}

describe.sequential("POST /conversation/[id]/code-execution", () => {
	it("records a file whose upload failed as uploaded: false, and a stored one as true", async () => {
		const { locals, conv } = await parkedRun();
		const form = new FormData();
		form.append("file", new Blob(["stored bytes"]), "kept.csv");
		const up = await upload({
			params: { id: conv._id.toString() },
			locals,
			request: new Request("http://localhost/x", { method: "POST", body: form }),
		} as never);
		const [kept] = ((await up.json()) as { files: { sha256: string; size: number }[] }).files;
		const lost = "e".repeat(64);

		const res = await POST({
			params: { id: conv._id.toString() },
			locals,
			request: new Request("http://localhost/x", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					executionId: EXECUTION_ID,
					outcome: {
						ok: true,
						stdout: "",
						stderr: "",
						files: [],
						fileRefs: [
							{ name: "kept.csv", size: kept.size, sha256: kept.sha256, uploaded: false },
							{ name: "sub/lost.pdf", size: 9, sha256: lost, uploaded: true },
						],
					},
				}),
			}),
		} as never);
		expect(res.status).toBe(200);

		const park = await collections.parkedCalls.findOne({ parkedCallId: EXECUTION_ID });
		// The server decides from its own store, whatever the client claimed.
		expect(park?.outcome?.fileRefs).toEqual([
			{ name: "kept.csv", size: kept.size, sha256: kept.sha256, uploaded: true },
			{ name: "sub/lost.pdf", size: 9, sha256: lost, uploaded: false },
		]);
		// And it rides on the resolved update the reload replays.
		expect(buildCodeExecutionResolvedUpdate(park!).files).toEqual(park?.outcome?.fileRefs);
	});

	it("still accepts the old shape (references without the field)", async () => {
		const { locals, conv } = await parkedRun();
		const res = await POST({
			params: { id: conv._id.toString() },
			locals,
			request: new Request("http://localhost/x", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					executionId: EXECUTION_ID,
					outcome: {
						ok: true,
						stdout: "",
						stderr: "",
						files: [],
						fileRefs: [{ name: "a.csv", size: 1, sha256: "a".repeat(64) }],
					},
				}),
			}),
		} as never);
		expect(res.status).toBe(200);
	});
});
