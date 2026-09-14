/**
 * Deleting a connector, and whose connector that may be (ADR 0064).
 *
 * The property is the same one `selection` guards from the other side: an id
 * must resolve to nothing rather than to somebody else's server. The new
 * edge here is the administrator's own view. An admin sees deployment
 * connectors in their MCP overlay because they are offered to them, and
 * `ownedBy` hands a deployment connector to whoever administers — which made
 * the overlay's Remove button work on rows they were only looking at in
 * their capacity as an administrator. The delete now has to *say* it is the
 * administrative one (`?scope=deployment`), the way the admin screen's
 * confirmation says "for everyone".
 *
 * Every negative assertion here is paired with a positive on the same data,
 * because a 404 from a query that matched nothing for an unrelated reason
 * passes any negative test (the trap the gateway's `sharing.py` records).
 */

import { describe, expect, it, afterEach, beforeAll, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";

import { DELETE } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";

beforeAll(async () => {
	await ready;
});

const owner = new ObjectId();
const admin = new ObjectId();

/** Every connector this file seeds, so the cleanup below can name them. */
const seeded: ObjectId[] = [];

async function addConnector(options: {
	userId: ObjectId;
	name: string;
	scope: "user" | "deployment";
}) {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: options.userId,
		scope: options.scope,
		name: options.name,
		url: `https://${options.name.toLowerCase()}.test/mcp`,
		auth: "none",
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	seeded.push(_id);
	return _id;
}

/** A locally-recognised administrator: `callerIdentity` asks the gateway, so the gateway's answer is stubbed. */
function stubAdminGateway() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ id: admin.toString(), is_admin: true }))
	);
}

/** Admin-shaped request metadata: a bearer token for the stubbed gateway to recognise. */
function adminLocals(user: TestUser): App.Locals {
	return { ...user.locals, token: "gateway-token" };
}

function deleteEvent(id: string, locals: App.Locals, query = "") {
	return {
		locals,
		params: { id },
		url: new URL(`http://localhost:5173/api/v2/mcp/connectors/${id}${query}`),
	} as never;
}

async function expectDeleted(id: ObjectId, locals: App.Locals, query = "") {
	const response = await DELETE(deleteEvent(id.toString(), locals, query));
	expect(response.status).toBe(204);
	expect(await collections.mcpConnectors.countDocuments({ _id: id })).toBe(0);
}

afterEach(async () => {
	vi.unstubAllGlobals();
	// The connector rows are the only ones this file owns, so they stay
	// named explicitly; the token rows hang off them, whatever user they name.
	await collections.mcpTokens.deleteMany({ connectorId: { $in: seeded } });
	await collections.mcpConnectors.deleteMany({ _id: { $in: seeded } });
	seeded.length = 0;
	// The users and sessions the fixture people came with.
	await cleanupTestData();
});

describe.sequential("DELETE /api/v2/mcp/connectors/[id]", () => {
	it("does not remove a deployment connector through the overlay's plain delete — even for an administrator", async () => {
		const user: TestUser = await createTestUser();
		const locals = adminLocals(user);
		const id = await addConnector({ userId: admin, name: "Shared", scope: "deployment" });
		stubAdminGateway();

		try {
			await DELETE(deleteEvent(id.toString(), locals));
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
		// The negative is only meaningful next to the positive: the same
		// administrator, saying the same thing the admin screen says, does
		// remove it. What this pins is intent, not role.
		await expectDeleted(id, locals, "?scope=deployment");
	});

	it("removes an owned connector with the plain delete the overlay sends", async () => {
		const user: TestUser = await createTestUser();
		const id = await addConnector({ userId: user.user._id, name: "Mine", scope: "user" });
		// A token row goes with the connector — the delete's other half.
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId: id,
			userId: user.user._id,
			accessTokenSealed: "sealed",
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const response = await DELETE(deleteEvent(id.toString(), user.locals));
		expect(response.status).toBe(204);
		expect(await collections.mcpConnectors.countDocuments({ _id: id })).toBe(0);
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(0);
	});

	it("still refuses an administrator who does not own somebody's personal connector", async () => {
		const user: TestUser = await createTestUser();
		const stranger: TestUser = await createTestUser();
		const id = await addConnector({ userId: user.user._id, name: "Theirs", scope: "user" });
		stubAdminGateway();

		try {
			await DELETE(deleteEvent(id.toString(), adminLocals(stranger), "?scope=deployment"));
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
		expect(await collections.mcpConnectors.countDocuments({ _id: id })).toBe(1);
	});

	it("refuses a non-administrator naming the deployment scope", async () => {
		const user: TestUser = await createTestUser();
		const id = await addConnector({ userId: owner, name: "Shared", scope: "deployment" });

		try {
			await DELETE(deleteEvent(id.toString(), user.locals, "?scope=deployment"));
			expect.fail("Should have thrown");
		} catch (e: unknown) {
			expect((e as { status: number }).status).toBe(404);
		}
		expect(await collections.mcpConnectors.countDocuments({ _id: id })).toBe(1);
	});
});
