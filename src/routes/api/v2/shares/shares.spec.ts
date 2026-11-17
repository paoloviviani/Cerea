/** The owner's and the administrator's share-link APIs (ADR 0120). */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const admin = vi.hoisted(() => ({ allowed: true }));
vi.mock("$lib/server/admin", async () => {
	const { error } = await import("@sveltejs/kit");
	return {
		requireAdmin: vi.fn(async () => {
			if (!admin.allowed) error(403, "forbidden");
			return { email: "admin@example.org", isAdmin: true };
		}),
	};
});

const { collections, ready } = await import("$lib/server/database");
await ready;
const { collections: db } = await import("$lib/server/database");
const { cleanupTestData, createTestConversation, createTestUser } =
	await import("$lib/server/api/__tests__/testHelpers");
const { testRequest } = await import("$lib/server/__tests__/testRequest");
const { forgetSharingSettingsCache } = await import("$lib/server/sharing/settings");
const owner = await import("./+server");
import type { RequestHandler } from "@sveltejs/kit";
const general = (handler: unknown) => handler as RequestHandler;
const ownerOne = await import("./[id]/+server");
const adminAll = await import("../admin/shares/+server");
const adminOne = await import("../admin/shares/[id]/+server");

beforeAll(async () => {
	await ready;
}, 30000);

afterEach(async () => {
	admin.allowed = true;
	await db.sharedArtifacts.deleteMany({});
	await db.shareSettings.deleteMany({});
	forgetSharingSettingsCache();
	await cleanupTestData();
});
void collections;

const message = (content: string) =>
	({
		id: "m1",
		from: "assistant",
		content,
		createdAt: new Date(),
		updatedAt: new Date(),
		children: [],
	}) as never;

async function chatOf(user: Awaited<ReturnType<typeof createTestUser>>) {
	return createTestConversation(user.locals, {
		title: "Chat",
		messages: [message('<artifact identifier="n" type="markdown" title="Notes"># n</artifact>')],
	});
}

const json = (body: unknown) => ({
	body: JSON.stringify(body),
	headers: { "content-type": "application/json" },
});

async function create(user: Awaited<ReturnType<typeof createTestUser>>, conversationId: string) {
	return testRequest(owner.POST, {
		path: "/api/v2/shares",
		method: "POST",
		locals: user.locals,
		...json({ kind: "text", conversationId, identifier: "n", audience: "anyone", expiryDays: 30 }),
	});
}

describe("the owner's API", () => {
	it("needs a signed-in user", async () => {
		const res = await testRequest(owner.GET, {
			path: "/api/v2/shares",
			locals: { sessionId: "s" },
		});
		expect(res.status).toBe(401);
	});

	it("makes a link, returns it once, and lists it without the token", async () => {
		const user = await createTestUser();
		const chat = await chatOf(user);
		const res = await create(user, chat._id.toString());
		expect(res.status).toBe(201);
		expect(res.headers.get("cache-control")).toContain("no-store");
		const made = await res.json();
		expect(made.url).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);

		const listed = await (
			await testRequest(owner.GET, { path: "/api/v2/shares", locals: user.locals })
		).json();
		expect(listed.enabled).toBe(true);
		expect(listed.data).toHaveLength(1);
		expect(listed.data[0]).toMatchObject({
			title: "Notes",
			audience: "anyone",
			status: "active",
			views: 0,
			artifactId: "n",
		});
		const token = made.url.split("/").pop();
		expect(JSON.stringify(listed)).not.toContain(token);
	});

	it("refuses another user's chat, a repeat, and a bad body", async () => {
		const user = await createTestUser();
		const chat = await chatOf(user);
		const stranger = await createTestUser();
		expect((await create(stranger, chat._id.toString())).status).toBe(404);
		expect((await create(user, chat._id.toString())).status).toBe(201);
		expect((await create(user, chat._id.toString())).status).toBe(409);
		const bad = await testRequest(owner.POST, {
			path: "/api/v2/shares",
			method: "POST",
			locals: user.locals,
			...json({ kind: "text", conversationId: "nope" }),
		});
		expect(bad.status).toBe(400);
	});

	it("changes and revokes only the owner's own link", async () => {
		const user = await createTestUser();
		const chat = await chatOf(user);
		const { share } = await (await create(user, chat._id.toString())).json();
		const patch = (who: typeof user, body: unknown) =>
			testRequest(general(ownerOne.PATCH), {
				path: `/api/v2/shares/${share.id}`,
				method: "PATCH",
				params: { id: share.id },
				locals: who.locals,
				...json(body),
			});
		const stranger = await createTestUser();
		expect((await patch(stranger, { audience: "signed_in" })).status).toBe(404);
		const changed = await (await patch(user, { audience: "signed_in", expiryDays: null })).json();
		expect(changed.share).toMatchObject({ audience: "signed_in", expiresAt: null });
		const rotated = await (await patch(user, { rotate: true })).json();
		expect(rotated.url).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);

		const del = (who: typeof user) =>
			testRequest(general(ownerOne.DELETE), {
				path: `/api/v2/shares/${share.id}`,
				method: "DELETE",
				params: { id: share.id },
				locals: who.locals,
			});
		expect((await del(stranger)).status).toBe(404);
		expect((await del(user)).status).toBe(200);
		expect((await del(user)).status).toBe(404);
	});

	it("refuses to make or change links while sharing is off, but still lists and revokes", async () => {
		const user = await createTestUser();
		const chat = await chatOf(user);
		const { share } = await (await create(user, chat._id.toString())).json();
		await db.shareSettings.insertOne({ _id: "global", enabled: false, updatedAt: new Date() });
		forgetSharingSettingsCache();
		expect((await create(user, chat._id.toString())).status).toBe(403);
		const patched = await testRequest(general(ownerOne.PATCH), {
			path: `/api/v2/shares/${share.id}`,
			method: "PATCH",
			params: { id: share.id },
			locals: user.locals,
			...json({ audience: "anyone" }),
		});
		expect(patched.status).toBe(403);
		const listed = await (
			await testRequest(owner.GET, { path: "/api/v2/shares", locals: user.locals })
		).json();
		expect(listed).toMatchObject({ enabled: false });
		expect(listed.data).toHaveLength(1);
		const revoked = await testRequest(general(ownerOne.DELETE), {
			path: `/api/v2/shares/${share.id}`,
			method: "DELETE",
			params: { id: share.id },
			locals: user.locals,
		});
		expect(revoked.status).toBe(200);
	});
});

describe("the administrator's API", () => {
	it("is for administrators only", async () => {
		admin.allowed = false;
		const user = await createTestUser();
		for (const res of [
			await testRequest(adminAll.GET, { path: "/api/v2/admin/shares", locals: user.locals }),
			await testRequest(adminAll.PATCH, {
				path: "/api/v2/admin/shares",
				method: "PATCH",
				locals: user.locals,
				...json({ enabled: false }),
			}),
		]) {
			expect(res.status).toBe(403);
		}
	});

	it("lists every user's links, toggles sharing and revokes any link", async () => {
		const a = await createTestUser();
		const b = await createTestUser();
		await create(a, (await chatOf(a))._id.toString());
		await create(b, (await chatOf(b))._id.toString());
		const boss = await createTestUser();

		const all = await (
			await testRequest(adminAll.GET, { path: "/api/v2/admin/shares", locals: boss.locals })
		).json();
		expect(all).toMatchObject({ enabled: true, envDefault: true });
		expect(all.data).toHaveLength(2);

		const off = await testRequest(adminAll.PATCH, {
			path: "/api/v2/admin/shares",
			method: "PATCH",
			locals: boss.locals,
			...json({ enabled: false }),
		});
		expect(await off.json()).toEqual({ enabled: false });
		const listed = await (
			await testRequest(owner.GET, { path: "/api/v2/shares", locals: a.locals })
		).json();
		expect(listed.enabled).toBe(false);

		const bad = await testRequest(adminAll.PATCH, {
			path: "/api/v2/admin/shares",
			method: "PATCH",
			locals: boss.locals,
			...json({ enabled: "maybe" }),
		});
		expect(bad.status).toBe(400);

		const id = all.data[0].id;
		const revoked = await testRequest(general(adminOne.DELETE), {
			path: `/api/v2/admin/shares/${id}`,
			method: "DELETE",
			params: { id },
			locals: boss.locals,
		});
		expect(revoked.status).toBe(200);
		expect(await db.sharedArtifacts.countDocuments({ revokedAt: { $ne: null } })).toBe(1);
	});
});
