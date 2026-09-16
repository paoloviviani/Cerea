/**
 * Deployment skills over the existing skills routes (ADR 0072 amendment).
 *
 * No new route family: `POST /api/v2/skills` takes `scope: "deployment"`,
 * and `PATCH`/`DELETE /api/v2/skills/[id]` branch on the row's own scope —
 * the server's admin gate owns the permission, never a client flag. Every
 * negative here is paired with a positive on the same data, because a 404
 * from a query that matched nothing for an unrelated reason passes any
 * negative test.
 */

import { describe, expect, it, afterEach, beforeAll, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";

import { GET, POST } from "../../../../routes/api/v2/skills/+server";
import { DELETE, PATCH, GET as GET_ONE } from "../../../../routes/api/v2/skills/[id]/+server";

beforeAll(async () => {
	await ready;
});

/** Deployment rows this file created, so the cleanup can name them. */
const created: string[] = [];

function doc(name: string, description = "Deployment procedure.") {
	return `---\nname: ${name}\ndescription: ${description}\n---\n\n# Procedure\n\nSteps.`;
}

/** `callerIdentity` asks the gateway, so the gateway's answer is stubbed. */
function stubGateway(isAdmin: boolean) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ id: "gateway-person", is_admin: isAdmin }))
	);
}

function localsWithToken(user: TestUser): App.Locals {
	return { ...user.locals, token: "gateway-token" };
}

function postEvent(locals: App.Locals, body: unknown) {
	return {
		locals,
		request: new Request("http://localhost:5173/api/v2/skills", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never;
}

function patchEvent(id: string, locals: App.Locals, body: unknown) {
	return {
		locals,
		params: { id },
		request: new Request(`http://localhost:5173/api/v2/skills/${id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never;
}

function deleteEvent(id: string, locals: App.Locals) {
	return { locals, params: { id } } as never;
}

function getEvent(locals: App.Locals) {
	return { locals } as never;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	if (created.length) {
		const { ObjectId } = await import("mongodb");
		await collections.skills.deleteMany({
			_id: { $in: created.map((id) => new ObjectId(id)) },
		});
		created.length = 0;
	}
	await cleanupTestData();
});

describe.sequential("POST /api/v2/skills with scope deployment", () => {
	it("403s for a non-administrator and stores nothing", async () => {
		const user = await createTestUser();
		stubGateway(false);
		try {
			await POST(
				postEvent(localsWithToken(user), { content: doc("admin-spec-route"), scope: "deployment" })
			);
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(403);
		}
		expect(await collections.skills.countDocuments({ name: "admin-spec-route" })).toBe(0);
	});

	it("creates a deployment row for an administrator, manageable rather than duplicated", async () => {
		const user = await createTestUser();
		stubGateway(true);
		const response = await POST(
			postEvent(localsWithToken(user), { content: doc("admin-spec-route"), scope: "deployment" })
		);
		expect(response.status).toBe(201);
		const createdBody = (await response.json()) as { data: { id: string } };
		created.push(createdBody.data.id);

		// The seeded rows appear in the same listing, once each — no
		// double-listing of seed + row.
		const listed = await GET(getEvent(user.locals));
		const listedBody = (await listed.json()) as {
			data: { user: unknown[]; admin: { id: string; name: string }[] };
		};
		const names = listedBody.data.admin.map((row) => row.name);
		expect(names).toContain("admin-spec-route");
		expect(names).toContain("csv-shaping");
		expect(names.filter((name) => name === "csv-shaping")).toHaveLength(1);
		expect(listedBody.data.admin.every((row) => row.id)).toBe(true);
	});

	it("rejects bad frontmatter like user skills do", async () => {
		const user = await createTestUser();
		stubGateway(true);
		try {
			await POST(
				postEvent(localsWithToken(user), {
					content: `---\nname: no-desc\n---\n\nBody.`,
					scope: "deployment",
				})
			);
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(400);
		}
	});
});

describe.sequential("PATCH/DELETE /api/v2/skills/[id] on a deployment row", () => {
	it("reads for everybody, but 403s a non-administrator's write with the row intact", async () => {
		const adminUser = await createTestUser();
		stubGateway(true);
		const createdResponse = await POST(
			postEvent(localsWithToken(adminUser), {
				content: doc("admin-spec-guarded"),
				scope: "deployment",
			})
		);
		const id = ((await createdResponse.json()) as { data: { id: string } }).data.id;
		created.push(id);
		vi.unstubAllGlobals();

		const stranger = await createTestUser();
		// Reading is offered to everybody the row is offered to.
		const read = await GET_ONE({ locals: stranger.locals, params: { id } } as never);
		expect(read.status).toBe(200);

		stubGateway(false);
		try {
			await PATCH(patchEvent(id, localsWithToken(stranger), { enabled: false }));
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(403);
		}
		try {
			await DELETE(deleteEvent(id, localsWithToken(stranger)));
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(403);
		}
		const { ObjectId } = await import("mongodb");
		expect(await collections.skills.countDocuments({ _id: new ObjectId(id) })).toBe(1);
	});

	it("disables, edits, and deletes for an administrator — disabling is a toggle", async () => {
		const adminUser = await createTestUser();
		stubGateway(true);
		const locals = localsWithToken(adminUser);
		const createdResponse = await POST(
			postEvent(locals, { content: doc("admin-spec-managed"), scope: "deployment" })
		);
		const id = ((await createdResponse.json()) as { data: { id: string } }).data.id;
		created.push(id);

		const disabled = await PATCH(patchEvent(id, locals, { enabled: false }));
		expect(((await disabled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);

		const edited = await PATCH(
			patchEvent(id, locals, { content: doc("admin-spec-managed", "New description.") })
		);
		expect(((await edited.json()) as { data: { description: string } }).data.description).toBe(
			"New description."
		);

		const deleted = await DELETE(deleteEvent(id, locals));
		expect(deleted.status).toBe(204);
		const { ObjectId } = await import("mongodb");
		expect(await collections.skills.countDocuments({ _id: new ObjectId(id) })).toBe(0);
		created.length = 0;
	});

	it("manages a seeded row: disable and re-enable round-trips", async () => {
		const adminUser = await createTestUser();
		const locals = localsWithToken(adminUser);
		const listed = await GET(getEvent(adminUser.locals));
		const seeds = (await listed.json()) as { data: { admin: { id: string; name: string }[] } };
		const seed = seeds.data.admin.find((row) => row.name === "csv-shaping");
		if (!seed) throw new Error("expected the csv-shaping seed row in the listing");
		const seedId = seed.id;

		stubGateway(true);
		try {
			const disabled = await PATCH(patchEvent(seedId, locals, { enabled: false }));
			expect(((await disabled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(false);
			const enabled = await PATCH(patchEvent(seedId, locals, { enabled: true }));
			expect(((await enabled.json()) as { data: { enabled: boolean } }).data.enabled).toBe(true);
		} finally {
			// Leave the deployment as found however the assertions land.
			await Promise.resolve(PATCH(patchEvent(seedId, locals, { enabled: true }))).catch(
				() => undefined
			);
		}
	});
});
