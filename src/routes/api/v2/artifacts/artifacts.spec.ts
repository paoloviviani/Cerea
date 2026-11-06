import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { GET } from "./+server";
import { GET as DOWNLOAD } from "./download/+server";

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

const day = (n: number) => new Date(Date.UTC(2026, 10, n));

async function file(
	conversationId: ObjectId,
	name: string,
	at: number,
	extra: Record<string, unknown> = {}
) {
	await collections.codeExecutionOutputs.insertOne({
		_id: new ObjectId(),
		conversationId,
		sha256: `${name}-${at}`.padEnd(64, "0"),
		name,
		mime: "application/octet-stream",
		size: 10,
		gridFsId: new ObjectId(),
		createdAt: day(at),
		...extra,
	} as never);
}

const artifactMessage = (id: string, body: string, at: number) =>
	({
		id,
		from: "assistant",
		content: body,
		createdAt: day(at),
		updatedAt: day(at),
		children: [],
	}) as never;

const tag = (identifier: string, title: string, content: string) =>
	`Here.\n<artifact identifier="${identifier}" type="html" title="${title}">${content}</artifact>`;

async function setup() {
	const owner = await createTestUser();
	const member = await createTestUser();
	const memberLocals = { ...member.locals, user: { ...member.user, email: "member@example.org" } };
	const projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner.user._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return { owner, memberLocals, projectId };
}

const list = (locals: Partial<App.Locals>, query: string) =>
	testRequest(GET, { path: `/api/v2/artifacts?${query}`, locals });

describe("GET /api/v2/artifacts", () => {
	it("lists files and text artifacts of a project's own chats, newest first, with versions", async () => {
		const { owner, projectId } = await setup();
		const chat = await createTestConversation(owner.locals, {
			projectId,
			title: "Report chat",
			messages: [artifactMessage("m1", tag("page", "Landing page", "<p>v1</p>"), 3)],
		});
		await file(chat._id, "report.docx", 1, { version: 1, tool: "doc_create" });
		await file(chat._id, "report.docx", 5, { version: 2, tool: "doc_edit" });
		const body = await (await list(owner.locals, `project=${projectId}`)).json();
		expect(
			body.data.map((i: { name: string; version: number; versionCount: number }) => [
				i.name,
				i.version,
				i.versionCount,
			])
		).toEqual([
			["report.docx", 2, 2],
			["Landing page", 1, 1],
		]);
		expect(body.data[0]).toMatchObject({
			kind: "file",
			conversationId: chat._id.toString(),
			conversationTitle: "Report chat",
			sha256: expect.any(String),
		});
		expect(body.data[1]).toMatchObject({ kind: "artifact", identifier: "page", type: "html" });
		expect(body.hasMore).toBe(false);
	});

	it("keeps free chats and project chats apart", async () => {
		const { owner, projectId } = await setup();
		const inProject = await createTestConversation(owner.locals, { projectId });
		const free = await createTestConversation(owner.locals);
		await file(inProject._id, "in-project.csv", 1);
		await file(free._id, "free.csv", 2);
		const names = async (query: string) =>
			(await (await list(owner.locals, query)).json()).data.map((i: { name: string }) => i.name);
		expect(await names(`project=${projectId}`)).toEqual(["in-project.csv"]);
		expect(await names("project=none")).toEqual(["free.csv"]);
	});

	it("never lists a colleague's chats in a shared project, nor their titles", async () => {
		const { owner, memberLocals, projectId } = await setup();
		const mine = await createTestConversation(owner.locals, { projectId, title: "Mine" });
		const theirs = await createTestConversation(memberLocals, {
			projectId,
			title: "Colleague salary talk",
			messages: [artifactMessage("m1", tag("secret", "Secret page", "x"), 2)],
		});
		await file(mine._id, "mine.csv", 1);
		await file(theirs._id, "theirs.csv", 2);
		const res = await list(owner.locals, `project=${projectId}`);
		const text = JSON.stringify(await res.clone().json());
		expect((await res.json()).data.map((i: { name: string }) => i.name)).toEqual(["mine.csv"]);
		expect(text).not.toContain("Colleague");
		expect(text).not.toContain("theirs.csv");
		const theirOwn = await (await list(memberLocals, `project=${projectId}`)).json();
		expect(theirOwn.data.map((i: { name: string }) => i.name)).toEqual([
			"Secret page",
			"theirs.csv",
		]);
	});

	it("is 404 for a project that is not shared with the caller, and does not mix users' free chats", async () => {
		const { owner, projectId } = await setup();
		const stranger = await createTestUser();
		expect((await list(stranger.locals, `project=${projectId}`)).status).toBe(404);
		const chat = await createTestConversation(owner.locals);
		await file(chat._id, "mine.csv", 1);
		const body = await (await list(stranger.locals, "project=none")).json();
		expect(body.data).toEqual([]);
	});

	it("drops a deleted chat's artifacts", async () => {
		const { owner } = await setup();
		const chat = await createTestConversation(owner.locals, {
			messages: [artifactMessage("m1", tag("page", "Page", "x"), 2)],
		});
		await file(chat._id, "a.csv", 1);
		expect((await (await list(owner.locals, "project=none")).json()).data).toHaveLength(2);
		await collections.conversations.deleteOne({ _id: chat._id });
		expect((await (await list(owner.locals, "project=none")).json()).data).toEqual([]);
	});

	it("does not list uploaded attachments, only what the model made", async () => {
		const { owner } = await setup();
		await createTestConversation(owner.locals, {
			messages: [
				{
					id: "u1",
					from: "user",
					content: "here is my file",
					files: [{ type: "hash", name: "upload.pdf", value: "abc", mime: "application/pdf" }],
					createdAt: day(1),
					updatedAt: day(1),
					children: [],
				} as never,
			],
		});
		const body = await (await list(owner.locals, "project=none")).json();
		expect(body.data).toEqual([]);
	});

	it("filters by name, ignoring case and accents, and pages", async () => {
		const { owner } = await setup();
		const chat = await createTestConversation(owner.locals);
		await file(chat._id, "Résumé.pdf", 1);
		for (let i = 0; i < 31; i += 1) await file(chat._id, `data-${i}.csv`, 2);
		const found = await (await list(owner.locals, "project=none&q=resume")).json();
		expect(found.data.map((i: { name: string }) => i.name)).toEqual(["Résumé.pdf"]);
		const first = await (await list(owner.locals, "project=none")).json();
		expect(first.data).toHaveLength(30);
		expect(first.hasMore).toBe(true);
		const second = await (await list(owner.locals, "project=none&p=1")).json();
		expect(second.data).toHaveLength(2);
		expect(second.hasMore).toBe(false);
	});

	it("asks which scope", async () => {
		const { owner } = await setup();
		expect((await list(owner.locals, "")).status).toBe(400);
	});
});

describe("GET /api/v2/artifacts/download", () => {
	it("serves a text artifact's latest version to its owner only", async () => {
		const { owner } = await setup();
		const chat = await createTestConversation(owner.locals, {
			messages: [artifactMessage("m1", tag("page", "Page", "<p>hi</p>"), 2)],
		});
		const get = (locals: Partial<App.Locals>) =>
			testRequest(DOWNLOAD, {
				path: `/api/v2/artifacts/download?conversation=${chat._id}&identifier=page`,
				locals,
			});
		const ok = await get(owner.locals);
		expect(ok.status).toBe(200);
		expect(await ok.text()).toBe("<p>hi</p>");
		expect(ok.headers.get("content-disposition")).toContain("page.html");
		const stranger = await createTestUser();
		expect((await get(stranger.locals)).status).toBe(404);
	});
});
