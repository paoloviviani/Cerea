import { describe, expect, it, afterEach, beforeAll } from "vitest";
import superjson from "superjson";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { CONV_NUM_PER_PAGE } from "$lib/constants/pagination";
import {
	createTestLocals,
	createTestUser,
	createTestConversation,
	cleanupTestData,
} from "./testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";

import { GET, DELETE } from "../../../../routes/api/v2/conversations/+server";

async function parseResponse<T = unknown>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

async function storeFile(name: string, conversation: string) {
	const upload = collections.bucket.openUploadStream(name, { metadata: { conversation } });
	upload.end(Buffer.from("bytes"));
	await new Promise((resolve) => upload.once("finish", resolve));
}

function conversationsPath(params?: Record<string, string>): string {
	const query = params ? `?${new URLSearchParams(params)}` : "";
	return `/api/v2/conversations${query}`;
}

beforeAll(async () => {
	await ready;
}, 30000);

describe.sequential("GET /api/v2/conversations", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("returns conversations for authenticated user", { timeout: 30000 }, async () => {
		const { locals } = await createTestUser();
		const conv = await createTestConversation(locals, { title: "My Chat" });

		const res = await testRequest(GET, { path: conversationsPath(), locals });

		expect(res.status).toBe(200);
		const data = await parseResponse<{
			conversations: Array<{ title: string; _id: { toString(): string } }>;
			hasMore: boolean;
		}>(res);
		expect(data.conversations).toHaveLength(1);
		expect(data.conversations[0].title).toBe("My Chat");
		expect(data.conversations[0]._id.toString()).toBe(conv._id.toString());
		expect(data.hasMore).toBe(false);
	});

	it("returns empty array for user with no conversations", async () => {
		const { locals } = await createTestUser();

		const res = await testRequest(GET, { path: conversationsPath(), locals });

		expect(res.status).toBe(200);
		const data = await parseResponse<{ conversations: unknown[]; hasMore: boolean }>(res);
		expect(data.conversations).toHaveLength(0);
		expect(data.hasMore).toBe(false);
	});

	it("supports pagination with p=0 and p=1", async () => {
		const { locals } = await createTestUser();

		// Create CONV_NUM_PER_PAGE + 5 conversations with distinct updatedAt values
		for (let i = 0; i < CONV_NUM_PER_PAGE + 5; i++) {
			await createTestConversation(locals, {
				title: `Conv ${i}`,
				updatedAt: new Date(Date.now() - (CONV_NUM_PER_PAGE + 5 - i) * 1000),
			});
		}

		const resPage0 = await testRequest(GET, { path: conversationsPath({ p: "0" }), locals });

		const dataPage0 = await parseResponse<{
			conversations: Array<{ title: string }>;
			hasMore: boolean;
		}>(resPage0);
		expect(dataPage0.conversations).toHaveLength(CONV_NUM_PER_PAGE);
		expect(dataPage0.hasMore).toBe(true);

		const resPage1 = await testRequest(GET, { path: conversationsPath({ p: "1" }), locals });

		const dataPage1 = await parseResponse<{
			conversations: Array<{ title: string }>;
			hasMore: boolean;
		}>(resPage1);
		expect(dataPage1.conversations).toHaveLength(5);
		expect(dataPage1.hasMore).toBe(false);
	});

	it("returns hasMore=true when more than CONV_NUM_PER_PAGE exist", async () => {
		const { locals } = await createTestUser();

		for (let i = 0; i < CONV_NUM_PER_PAGE + 1; i++) {
			await createTestConversation(locals, {
				title: `Conv ${i}`,
				updatedAt: new Date(Date.now() - i * 1000),
			});
		}

		const res = await testRequest(GET, { path: conversationsPath(), locals });

		const data = await parseResponse<{ conversations: unknown[]; hasMore: boolean }>(res);
		expect(data.conversations).toHaveLength(CONV_NUM_PER_PAGE);
		expect(data.hasMore).toBe(true);
	});

	it("sorts by updatedAt descending", async () => {
		const { locals } = await createTestUser();

		await createTestConversation(locals, {
			title: "Oldest",
			updatedAt: new Date("2024-01-01"),
		});
		await createTestConversation(locals, {
			title: "Newest",
			updatedAt: new Date("2024-06-01"),
		});
		await createTestConversation(locals, {
			title: "Middle",
			updatedAt: new Date("2024-03-01"),
		});

		const res = await testRequest(GET, { path: conversationsPath(), locals });

		const data = await parseResponse<{ conversations: Array<{ title: string }> }>(res);
		expect(data.conversations[0].title).toBe("Newest");
		expect(data.conversations[1].title).toBe("Middle");
		expect(data.conversations[2].title).toBe("Oldest");
	});

	it("returns 401 for unauthenticated request", async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });

		const res = await testRequest(GET, { path: conversationsPath(), locals });

		expect(res.status).toBe(401);
	});

	it("does not return other users' conversations", async () => {
		const { locals: localsA } = await createTestUser();
		const { locals: localsB } = await createTestUser();

		await createTestConversation(localsA, { title: "User A Chat" });
		await createTestConversation(localsB, { title: "User B Chat" });

		const res = await testRequest(GET, { path: conversationsPath(), locals: localsA });

		const data = await parseResponse<{ conversations: Array<{ title: string }> }>(res);
		expect(data.conversations).toHaveLength(1);
		expect(data.conversations[0].title).toBe("User A Chat");
	});

	it("scopes results to the session resolved from a real cookie", async () => {
		const { locals, cookie } = await createTestUser();
		await createTestConversation(locals, { title: "Cookie Chat" });
		const { locals: other } = await createTestUser();
		await createTestConversation(other, { title: "Someone Else" });

		const res = await testRequest(GET, { path: conversationsPath(), headers: { cookie } });

		const data = await parseResponse<{ conversations: Array<{ title: string }> }>(res);
		expect(data.conversations).toHaveLength(1);
		expect(data.conversations[0].title).toBe("Cookie Chat");
	});
});

describe.sequential("GET /api/v2/conversations?q= (title search)", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	type Listed = { conversations: Array<{ title: string; projectId?: string }>; hasMore: boolean };
	const search = async (locals: App.Locals, q: string, extra: Record<string, string> = {}) =>
		parseResponse<Listed>(
			await testRequest(GET, { path: conversationsPath({ q, ...extra }), locals })
		);
	const titles = (listed: Listed) => listed.conversations.map((c) => c.title);

	it("returns the titles that contain the query, newest first", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, {
			title: "Mortgage rates",
			updatedAt: new Date("2024-01-01"),
		});
		await createTestConversation(locals, {
			title: "Fix my mortgage spreadsheet",
			updatedAt: new Date("2024-05-01"),
		});
		await createTestConversation(locals, {
			title: "Pasta recipe",
			updatedAt: new Date("2024-06-01"),
		});

		expect(titles(await search(locals, "mortgage"))).toEqual([
			"Fix my mortgage spreadsheet",
			"Mortgage rates",
		]);
	});

	it("returns nothing when no title matches", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "Pasta recipe" });

		const listed = await search(locals, "mortgage");
		expect(listed.conversations).toEqual([]);
		expect(listed.hasMore).toBe(false);
	});

	it("treats an empty or blank query as no filter", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "One" });
		await createTestConversation(locals, { title: "Two" });

		expect(await search(locals, "")).toMatchObject({ conversations: [{}, {}] });
		expect((await search(locals, "   ")).conversations).toHaveLength(2);
	});

	it("takes regex characters literally", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "Why c++ templates (again)?" });
		await createTestConversation(locals, { title: "Plain C talk" });
		await createTestConversation(locals, { title: "price $5 [draft] a.b" });
		await createTestConversation(locals, { title: "axb" });

		expect(titles(await search(locals, "c++"))).toEqual(["Why c++ templates (again)?"]);
		expect(titles(await search(locals, "(again)?"))).toEqual(["Why c++ templates (again)?"]);
		expect(titles(await search(locals, "[draft]"))).toEqual(["price $5 [draft] a.b"]);
		// An unescaped `.` would also match "axb".
		expect(titles(await search(locals, "a.b"))).toEqual(["price $5 [draft] a.b"]);
		// `.*` is two characters, not "anything".
		expect((await search(locals, ".*")).conversations).toEqual([]);
		// A pattern that is invalid as a regex is just text.
		expect((await search(locals, "(((")).conversations).toEqual([]);
	});

	it("ignores case and accents, in either direction", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "Café Müller à Zürich" });
		await createTestConversation(locals, { title: "Cafe Muller" });
		await createTestConversation(locals, { title: "ÉCOLE normale" });
		// A title stored decomposed: "e" then U+0301.
		await createTestConversation(locals, { title: "re\u0301sume\u0301 notes" });
		await createTestConversation(locals, { title: "Zażółć gęślą" });

		expect(titles(await search(locals, "CAFE"))).toHaveLength(2);
		expect(titles(await search(locals, "café"))).toHaveLength(2);
		expect(titles(await search(locals, "muller"))).toHaveLength(2);
		expect(titles(await search(locals, "zurich"))).toEqual(["Café Müller à Zürich"]);
		expect(titles(await search(locals, "ecole"))).toEqual(["ÉCOLE normale"]);
		expect(titles(await search(locals, "école"))).toEqual(["ÉCOLE normale"]);
		expect(titles(await search(locals, "résumé"))).toEqual(["re\u0301sume\u0301 notes"]);
		expect(titles(await search(locals, "resume"))).toEqual(["re\u0301sume\u0301 notes"]);
		expect(titles(await search(locals, "zazolc"))).toEqual(["Zażółć gęślą"]);
	});

	it("matches across runs of whitespace", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "plan   the  trip" });

		expect(titles(await search(locals, "plan the trip"))).toEqual(["plan   the  trip"]);
	});

	it("only searches the caller's own conversations", async () => {
		const { locals } = await createTestUser();
		const other = await createTestUser();
		await createTestConversation(locals, { title: "Mine: budget" });
		await createTestConversation(other.locals, { title: "Theirs: budget" });
		// An anonymous session's chat is no one's but that session's.
		await createTestConversation(createTestLocals({ sessionId: "someone-else" }), {
			title: "Session: budget",
		});

		expect(titles(await search(locals, "budget"))).toEqual(["Mine: budget"]);
		expect(titles(await search(other.locals, "budget"))).toEqual(["Theirs: budget"]);
	});

	it("includes the caller's project chats, marked with the project", async () => {
		const { locals } = await createTestUser();
		const projectId = new ObjectId();
		await createTestConversation(locals, { title: "Loose budget chat" });
		await createTestConversation(locals, { title: "Project budget chat", projectId });

		const listed = await search(locals, "budget");
		expect(titles(listed).sort()).toEqual(["Loose budget chat", "Project budget chat"]);
		expect(listed.conversations.find((c) => c.title === "Project budget chat")?.projectId).toBe(
			projectId.toString()
		);
	});

	it("pages the matches with p, and reports hasMore", async () => {
		const { locals } = await createTestUser();
		for (let i = 0; i < CONV_NUM_PER_PAGE + 5; i++) {
			await createTestConversation(locals, {
				title: `needle ${i}`,
				updatedAt: new Date(Date.now() - i * 1000),
			});
		}
		for (let i = 0; i < 10; i++) await createTestConversation(locals, { title: `hay ${i}` });

		const first = await search(locals, "needle", { p: "0" });
		expect(first.conversations).toHaveLength(CONV_NUM_PER_PAGE);
		expect(first.hasMore).toBe(true);
		expect(first.conversations[0].title).toBe("needle 0");

		const second = await search(locals, "needle", { p: "1" });
		expect(second.conversations).toHaveLength(5);
		expect(second.hasMore).toBe(false);
		expect(titles(second).every((t) => t.startsWith("needle"))).toBe(true);
	});

	it("caps the query length instead of failing on a huge one", async () => {
		const { locals } = await createTestUser();
		await createTestConversation(locals, { title: "short title" });

		const res = await testRequest(GET, {
			path: conversationsPath({ q: "x".repeat(50_000) }),
			locals,
		});
		expect(res.status).toBe(200);
		expect((await parseResponse<Listed>(res)).conversations).toEqual([]);
		// Past the cap the rest is ignored: the first 100 characters are the query.
		await createTestConversation(locals, { title: "y".repeat(100) });
		expect(titles(await search(locals, "y".repeat(100) + "zzz"))).toEqual(["y".repeat(100)]);
	});

	it("still requires a sign-in", async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });
		const res = await testRequest(GET, { path: conversationsPath({ q: "a" }), locals });
		expect(res.status).toBe(401);
	});
});

describe.sequential("DELETE /api/v2/conversations", () => {
	afterEach(async () => {
		await cleanupTestData();
	});

	it("removes all conversations for the authenticated user, project chats included, with what they stored", async () => {
		const { locals } = await createTestUser();
		const projectId = new ObjectId();

		await createTestConversation(locals, { title: "Chat 1" });
		await createTestConversation(locals, { title: "Chat 2" });
		await createTestConversation(locals, { title: "Chat 3" });
		const projectConv = await createTestConversation(locals, { title: "Project Chat", projectId });
		const projectChat = projectConv._id.toString();
		await storeFile(`${projectChat}-abc`, projectChat);

		const res = await testRequest(DELETE, {
			path: conversationsPath(),
			method: "DELETE",
			locals,
		});
		expect(res.status).toBe(200);

		const data = await parseResponse<number>(res);
		expect(data).toBe(4);
		expect(await collections.conversations.countDocuments()).toBe(0);
		expect(
			await collections.bucketFiles.countDocuments({ "metadata.conversation": projectChat })
		).toBe(0);
	});

	it("returns 401 for unauthenticated request", async () => {
		const locals = createTestLocals({ sessionId: undefined, user: undefined });

		const res = await testRequest(DELETE, {
			path: conversationsPath(),
			method: "DELETE",
			locals,
		});

		expect(res.status).toBe(401);
	});

	it("does not remove other users' conversations", async () => {
		const { locals: localsA } = await createTestUser();
		const { locals: localsB } = await createTestUser();

		await createTestConversation(localsA, { title: "User A Chat" });
		await createTestConversation(localsB, { title: "User B Chat" });

		const res = await testRequest(DELETE, {
			path: conversationsPath(),
			method: "DELETE",
			locals: localsA,
		});
		const data = await parseResponse<number>(res);
		expect(data).toBe(1);

		const remaining = await collections.conversations.countDocuments();
		expect(remaining).toBe(1);

		const userBConvs = await collections.conversations
			.find({ userId: localsB.user?._id })
			.toArray();
		expect(userBConvs).toHaveLength(1);
		expect(userBConvs[0].title).toBe("User B Chat");
	});
});
