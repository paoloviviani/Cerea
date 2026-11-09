import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const reindexMock = vi.hoisted(() => vi.fn(async () => ({ data: [] })));
const retryMock = vi.hoisted(() => vi.fn(async (...args: unknown[]) => ({ args })));
vi.mock("$lib/server/knowledge/service", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/knowledge/service")>()),
	reindex: reindexMock,
	retryDocument: retryMock,
	reindexTarget: vi.fn(async () => ({})),
}));

import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET, POST } from "./+server";
import { POST as RETRY } from "./retry/+server";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(() => {
	reindexMock.mockClear();
	retryMock.mockClear();
});

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
	await collections.knowledgeDocuments.deleteMany({});
});

const BASE = new ObjectId();

async function setup(extra: Record<string, unknown> = { memoryBaseId: BASE.toString() }) {
	const owner = await createTestUser();
	const member = await createTestUser();
	const outsider = await createTestUser();
	const withToken = (u: Awaited<ReturnType<typeof createTestUser>>, email: string) => ({
		...u.locals,
		token: "tok",
		user: { ...u.user, email },
	});
	const projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner.user._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: true,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	} as never);
	return {
		projectId,
		params: { id: projectId.toString() },
		ownerLocals: withToken(owner, "owner@example.org"),
		memberLocals: withToken(member, "member@example.org"),
		outsiderLocals: withToken(outsider, "outsider@example.org"),
	};
}

const path = (id: ObjectId, tail = "") => `/api/v2/projects/${id}/past-chats${tail}`;

async function addDoc(status: string, error = "") {
	await collections.knowledgeDocuments.insertOne({
		_id: new ObjectId(),
		storeId: BASE,
		status,
		error,
		title: "t",
		chunkCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
}

describe("/api/v2/projects/[id]/past-chats", () => {
	it("answers a non-member 404 and a read-only member 403 on Reindex and Retry", async () => {
		const { projectId, params, memberLocals, outsiderLocals } = await setup();
		const call = (handler: typeof POST, tail: string, locals: App.Locals) =>
			testRequest(handler, { path: path(projectId, tail), method: "POST", params, locals });

		expect((await call(POST, "", outsiderLocals)).status).toBe(404);
		expect((await call(RETRY, "/retry", outsiderLocals)).status).toBe(404);
		expect((await call(POST, "", memberLocals)).status).toBe(403);
		expect((await call(RETRY, "/retry", memberLocals)).status).toBe(403);
		expect(reindexMock).not.toHaveBeenCalled();
		expect(retryMock).not.toHaveBeenCalled();
	});

	it("reports the status to a member, with canManage only for the owner", async () => {
		const { projectId, params, ownerLocals, memberLocals, outsiderLocals } = await setup();
		await addDoc("ready");
		await addDoc("failed", "429 Quota exceeded. global per user limit of 0.5 exceeded");
		const read = async (locals: App.Locals) =>
			testRequest(GET, { path: path(projectId), params, locals });

		const owner = (await (await read(ownerLocals)).json()) as { data: Record<string, unknown> };
		expect(owner.data).toMatchObject({ state: "failed", indexed: 1, failed: 1, canManage: true });
		// The friendly sentence, never the gateway's wording.
		expect(owner.data.error).toMatch(/usage allowance had run out/);
		const member = (await (await read(memberLocals)).json()) as { data: { canManage: boolean } };
		expect(member.data.canManage).toBe(false);
		expect((await read(outsiderLocals)).status).toBe(404);
	});

	it("says not indexed for a project without a base", async () => {
		const { projectId, params, ownerLocals } = await setup({});
		const res = await testRequest(GET, { path: path(projectId), params, locals: ownerLocals });
		expect(((await res.json()) as { data: { state: string } }).data.state).toBe("none");
		const post = await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params,
			locals: ownerLocals,
		});
		expect(post.status).toBe(404);
	});

	it("lets the owner reindex through the knowledge base reindex, and retry the failed ones", async () => {
		const { projectId, params, ownerLocals, memberLocals } = await setup();
		await addDoc("failed", "boom");
		const res = await testRequest(POST, {
			path: path(projectId),
			method: "POST",
			params,
			locals: ownerLocals,
		});
		expect(res.status).toBe(200);
		expect(reindexMock).toHaveBeenCalledWith(BASE.toString(), expect.anything(), "tok", {});

		// The owner's embedder choice travels with the reindex; a member's does not.
		const withModel = (locals: App.Locals) =>
			testRequest(POST, {
				path: path(projectId),
				method: "POST",
				params,
				locals,
				body: JSON.stringify({ embedding_model: "other-embed" }),
				headers: { "content-type": "application/json" },
			});
		expect((await withModel(memberLocals)).status).toBe(403);
		expect((await withModel(ownerLocals)).status).toBe(200);
		expect(reindexMock).toHaveBeenLastCalledWith(BASE.toString(), expect.anything(), "tok", {
			embeddingModel: "other-embed",
		});

		const retried = await testRequest(RETRY, {
			path: path(projectId, "/retry"),
			method: "POST",
			params,
			locals: ownerLocals,
		});
		expect(retried.status).toBe(200);
		expect(retryMock).toHaveBeenCalledTimes(1);
		expect(retryMock.mock.calls[0]?.[0]).toBe(BASE.toString());
	});
});
