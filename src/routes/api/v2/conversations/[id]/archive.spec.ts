import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import superjson from "superjson";

const { deleteDerivedMock } = vi.hoisted(() => ({ deleteDerivedMock: vi.fn() }));
vi.mock("$lib/server/knowledge/deleteDerived", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/knowledge/deleteDerived")>();
	return { ...actual, deleteDerived: deleteDerivedMock };
});

vi.mock("$lib/server/projects", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/projects")>()),
	indexConversation: vi.fn().mockResolvedValue(undefined),
}));

import { collections, ready } from "$lib/server/database";
import {
	cleanupTestData,
	createTestConversation,
	createTestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { PATCH } from "./+server";
import { GET as LIST } from "../+server";
import { GET as PROJECT_CHATS } from "../../projects/[id]/conversations/+server";

beforeAll(async () => {
	await ready;
}, 30000);

beforeEach(() => {
	deleteDerivedMock.mockResolvedValue(undefined);
});

afterEach(async () => {
	deleteDerivedMock.mockReset();
	await cleanupTestData();
	await collections.projects.deleteMany({});
});

async function project(userId: ObjectId, shareEmail?: string) {
	const _id = new ObjectId();
	await collections.projects.insertOne({
		_id,
		userId,
		name: "Mine",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: true,
		retrievalLimit: 6,
		shares: shareEmail ? [{ kind: "user", email: shareEmail }] : [],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id;
}

const patch = (id: ObjectId, body: unknown, locals: Partial<App.Locals>) =>
	testRequest(PATCH, {
		path: `/api/v2/conversations/${id}`,
		method: "PATCH",
		params: { id: id.toString() },
		body: JSON.stringify(body),
		headers: { "content-type": "application/json" },
		locals,
	});

const list = async (locals: Partial<App.Locals>, query = "") => {
	const res = await testRequest(LIST, { path: `/api/v2/conversations${query}`, locals });
	expect(res.status).toBe(200);
	return superjson.parse<{
		conversations: { title: string; archivedAt?: Date }[];
		hasMore: boolean;
	}>(await res.text());
};
const titles = (data: { conversations: { title: string }[] }) =>
	data.conversations.map((c) => c.title);

const ownerId = (locals: App.Locals) => {
	if (!locals.user) throw new Error("no user");
	return locals.user._id;
};

const stored = (id: ObjectId) => collections.conversations.findOne({ _id: id });

describe("PATCH /api/v2/conversations/[id] { archived }", () => {
	it("archives a chat and unarchives it again", async () => {
		const { locals } = await createTestUser();
		const chat = await createTestConversation(locals);
		const res = await patch(chat._id, { archived: true }, locals);
		expect(res.status).toBe(200);
		expect((await stored(chat._id))?.archivedAt).toBeInstanceOf(Date);

		const back = await patch(chat._id, { archived: false }, locals);
		expect(back.status).toBe(200);
		const kept = await stored(chat._id);
		expect(kept).not.toBeNull();
		expect(kept?.archivedAt).toBeUndefined();
	});

	it("keeps the first archive date when archiving twice", async () => {
		const { locals } = await createTestUser();
		const chat = await createTestConversation(locals);
		await patch(chat._id, { archived: true }, locals);
		const first = (await stored(chat._id))?.archivedAt;
		await patch(chat._id, { archived: true }, locals);
		expect((await stored(chat._id))?.archivedAt).toEqual(first);
	});

	it("refuses a body that is not a boolean", async () => {
		const { locals } = await createTestUser();
		const chat = await createTestConversation(locals);
		expect((await patch(chat._id, { archived: "yes" }, locals)).status).toBe(400);
		expect((await stored(chat._id))?.archivedAt).toBeUndefined();
	});

	it("is the owner's alone: someone else's chat looks missing, in a shared project too", async () => {
		const owner = await createTestUser();
		const other = await createTestUser();
		const shared = await project(other.user._id, "owner@example.org");
		const ownerLocals = { ...owner.locals, user: { ...owner.user, email: "owner@example.org" } };
		const theirs = await createTestConversation(other.locals);
		const theirsInShared = await createTestConversation(other.locals, { projectId: shared });
		// The project's owner is not the chat's author either.
		const mineInTheirs = await createTestConversation(ownerLocals, { projectId: shared });

		expect((await patch(theirs._id, { archived: true }, ownerLocals)).status).toBe(404);
		expect((await patch(theirsInShared._id, { archived: true }, ownerLocals)).status).toBe(404);
		expect((await patch(mineInTheirs._id, { archived: true }, other.locals)).status).toBe(404);
		expect((await stored(theirs._id))?.archivedAt).toBeUndefined();
		const untouched = await stored(theirsInShared._id);
		expect(untouched?.archivedAt).toBeUndefined();
		expect(untouched?.projectId?.toString()).toBe(shared.toString());
		expect((await stored(mineInTheirs._id))?.archivedAt).toBeUndefined();
		expect(deleteDerivedMock).not.toHaveBeenCalled();

		// The author of a chat in a shared project can archive it.
		expect((await patch(mineInTheirs._id, { archived: true }, ownerLocals)).status).toBe(200);
	});

	it("removes a project chat from its project, with the memory cleanup of Remove from project", async () => {
		const { locals } = await createTestUser();
		const chat = await createTestConversation(locals);
		const proj = await project(ownerId(locals));
		await collections.conversations.updateOne({ _id: chat._id }, { $set: { projectId: proj } });

		const res = await patch(chat._id, { archived: true }, locals);
		expect(res.status).toBe(200);
		expect(superjson.parse<{ leftProject: boolean }>(await res.text()).leftProject).toBe(true);
		const kept = await stored(chat._id);
		expect(kept?.archivedAt).toBeInstanceOf(Date);
		expect(kept?.projectId).toBeUndefined();
		expect(deleteDerivedMock).toHaveBeenCalledWith({ conversationId: chat._id });

		// Unarchiving returns it as a normal chat, not to the project.
		await patch(chat._id, { archived: false }, locals);
		const back = await stored(chat._id);
		expect(back?.archivedAt).toBeUndefined();
		expect(back?.projectId).toBeUndefined();
	});

	it("does not clean up project memory for a chat that was in no project", async () => {
		const { locals } = await createTestUser();
		const chat = await createTestConversation(locals);
		const res = await patch(chat._id, { archived: true }, locals);
		expect(superjson.parse<{ leftProject: boolean }>(await res.text()).leftProject).toBe(false);
		expect(deleteDerivedMock).not.toHaveBeenCalled();
	});
});

describe("conversation lists and archived chats", () => {
	it("leaves archived chats out of the list and shows them under archived=1, newest archived first", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "Live one" });
		await createTestConversation(locals, {
			title: "Archived old",
			archivedAt: new Date("2026-01-01"),
		});
		await createTestConversation(locals, {
			title: "Archived new",
			archivedAt: new Date("2026-02-01"),
		});
		await createTestConversation(locals, { title: "Explicit null", archivedAt: null });

		expect(titles(await list(locals)).sort()).toEqual(["Explicit null", "Live one"]);
		const archived = await list(locals, "?archived=1");
		expect(titles(archived)).toEqual(["Archived new", "Archived old"]);
		expect(archived.conversations[0].archivedAt).toBeInstanceOf(Date);
	});

	it("searches only live chats on the Chats tab and only archived ones on the Archived tab", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "Budget live" });
		await createTestConversation(locals, { title: "Budget archived", archivedAt: new Date() });
		await createTestConversation(locals, { title: "Other archived", archivedAt: new Date() });

		expect(titles(await list(locals, "?q=budget"))).toEqual(["Budget live"]);
		expect(titles(await list(locals, "?q=budget&archived=1"))).toEqual(["Budget archived"]);
	});

	it("never lists another user's archived chats", async () => {
		const mine = await createTestUser();
		const other = await createTestUser();
		await createTestConversation(other.locals, { title: "Theirs", archivedAt: new Date() });
		expect((await list(mine.locals, "?archived=1")).conversations).toHaveLength(0);
	});

	it("leaves an archived chat out of a project's chat list", async () => {
		const { locals } = await createTestUser();
		const proj = await project(ownerId(locals));
		await createTestConversation(locals, { title: "In project", projectId: proj });
		await createTestConversation(locals, {
			title: "Archived in project",
			projectId: proj,
			archivedAt: new Date(),
		});
		const res = await testRequest(PROJECT_CHATS, {
			path: `/api/v2/projects/${proj}/conversations`,
			params: { id: proj.toString() },
			locals,
		});
		const body = (await res.json()) as { data: { title: string }[] };
		expect(body.data.map((c) => c.title)).toEqual(["In project"]);
	});

	it("moving an archived chat into a project unarchives it", async () => {
		const { locals } = await createTestUser();
		const proj = await project(ownerId(locals));
		const chat = await createTestConversation(locals, { archivedAt: new Date() });
		const res = await patch(chat._id, { projectId: proj.toString() }, locals);
		expect(res.status).toBe(200);
		const moved = await stored(chat._id);
		expect(moved?.archivedAt).toBeUndefined();
		expect(moved?.projectId?.toString()).toBe(proj.toString());
	});
});
