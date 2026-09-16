import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { collections, ready } from "$lib/server/database";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "$lib/server/api/__tests__/testHelpers";

import { POST } from "./+server";
import { GET } from "./[sha256]/+server";

function uploadRequest(files: Array<{ name: string; content: string; type?: string }>): Request {
	const form = new FormData();
	for (const f of files) {
		form.append("file", new Blob([f.content], { type: f.type ?? "text/plain" }), f.name);
	}
	// A real Request so `request.formData()` behaves exactly as it does in
	// production, rather than a hand-rolled stub of just that one method.
	return new Request("http://localhost/irrelevant", { method: "POST", body: form });
}

beforeAll(async () => {
	await ready;
});

describe.sequential("POST /conversation/[id]/code-execution/output", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("stores an uploaded deliverable and returns its reference", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);

		const res = await POST({
			params: { id: conv._id.toString() },
			locals,
			request: uploadRequest([{ name: "report.txt", content: "hello deliverable" }]),
		} as never);

		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			files: Array<{ name: string; size: number; sha256: string }>;
		};
		expect(body.files).toHaveLength(1);
		expect(body.files[0].name).toBe("report.txt");
		expect(body.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);

		const stored = await collections.codeExecutionOutputs.findOne({ conversationId: conv._id });
		expect(stored?.userId).toEqual(locals.user?._id);
	});

	it("refuses a stranger's conversation with 404, not 403 — existence is not disclosed", async () => {
		const { locals: owner } = await createTestUser();
		const conv = await createTestConversation(owner);
		const { locals: stranger } = await createTestUser();

		await expect(
			POST({
				params: { id: conv._id.toString() },
				locals: stranger,
				request: uploadRequest([{ name: "x.txt", content: "x" }]),
			} as never)
		).rejects.toMatchObject({ status: 404 });
	});

	it("refuses an unauthenticated request", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);

		await expect(
			POST({
				params: { id: conv._id.toString() },
				locals: createTestLocals({ sessionId: undefined }),
				request: uploadRequest([{ name: "x.txt", content: "x" }]),
			} as never)
		).rejects.toMatchObject({ status: 401 });
	});

	it("dedups a re-uploaded identical file instead of storing it twice", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const body = { name: "same.txt", content: "identical bytes" };

		const first = await POST({
			params: { id: conv._id.toString() },
			locals,
			request: uploadRequest([body]),
		} as never);
		const second = await POST({
			params: { id: conv._id.toString() },
			locals,
			request: uploadRequest([body]),
		} as never);

		const firstBody = (await first.json()) as { files: Array<{ sha256: string }> };
		const secondBody = (await second.json()) as { files: Array<{ sha256: string }> };
		expect(secondBody.files[0].sha256).toBe(firstBody.files[0].sha256);
		expect(
			await collections.codeExecutionOutputs.countDocuments({ conversationId: conv._id })
		).toBe(1);
	});
});

describe.sequential("GET /conversation/[id]/code-execution/output/[sha256]", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("serves the uploaded bytes back to the owner", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);
		const uploadRes = await POST({
			params: { id: conv._id.toString() },
			locals,
			request: uploadRequest([{ name: "download-me.txt", content: "the actual bytes" }]),
		} as never);
		const { files } = (await uploadRes.json()) as { files: Array<{ sha256: string }> };

		const res = await GET({
			params: { id: conv._id.toString(), sha256: files[0].sha256 },
			locals,
		} as never);

		expect(res.status).toBe(200);
		expect(await res.text()).toBe("the actual bytes");
		expect(res.headers.get("Content-Disposition")).toContain("download-me.txt");
	});

	it("refuses a non-owner", async () => {
		const { locals: owner } = await createTestUser();
		const conv = await createTestConversation(owner);
		const uploadRes = await POST({
			params: { id: conv._id.toString() },
			locals: owner,
			request: uploadRequest([{ name: "secret.txt", content: "not yours" }]),
		} as never);
		const { files } = (await uploadRes.json()) as { files: Array<{ sha256: string }> };

		const { locals: stranger } = await createTestUser();
		await expect(
			GET({
				params: { id: conv._id.toString(), sha256: files[0].sha256 },
				locals: stranger,
			} as never)
		).rejects.toMatchObject({ status: 404 });
	});

	it("404s for an unknown sha256", async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals);

		await expect(
			GET({ params: { id: conv._id.toString(), sha256: "f".repeat(64) }, locals } as never)
		).rejects.toMatchObject({ status: 404 });
	});
});
