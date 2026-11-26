/**
 * Connector names are unique where they can be refused (C169): a user's own connector
 * against their others and the deployment's; a deployment connector against the other
 * deployment ones. The probe and the tool listing are stubbed: this is about the name.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const gate = vi.hoisted(() => ({ admin: false }));
vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!gate.admin) throw Object.assign(new Error("no"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
	callerIdentity: vi.fn(async () => ({ email: "admin@example.org", isAdmin: gate.admin })),
}));
vi.mock("$lib/server/mcp/discovery", () => ({ probe: vi.fn(async () => ({ auth: "none" })) }));
vi.mock("$lib/server/mcp/check", () => ({ checkConnectorTools: vi.fn(async () => undefined) }));
vi.mock("$lib/server/mcp/registry", () => ({
	getMcpServers: () => [{ name: "Env Search", url: "https://env.test/mcp" }],
}));

import { collections, ready } from "$lib/server/database";
import type { McpConnector } from "$lib/types/McpConnector";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";
import { POST as createRoute } from "../../../../routes/api/v2/mcp/connectors/+server";
import { POST as actRoute } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";

const create = createRoute as unknown as (event: unknown) => Promise<Response>;
const act = actRoute as unknown as (event: unknown) => Promise<Response>;

let me: TestUser;
let other: TestUser;
const seeded: ObjectId[] = [];
const originalKey = process.env.CHAT_SECRET_KEY;

beforeAll(async () => {
	await ready;
	process.env.CHAT_SECRET_KEY ||= "mcp-connector-names-spec";
	me = await createTestUser();
	other = await createTestUser();
});
afterAll(async () => {
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
	else process.env.CHAT_SECRET_KEY = originalKey;
	await cleanupTestData();
});
beforeEach(() => {
	gate.admin = false;
});
afterEach(async () => {
	await collections.mcpConnectors.deleteMany({ _id: { $in: seeded.splice(0) } });
});

async function seed(
	owner: TestUser,
	name: string,
	scope: "user" | "deployment" = "user"
): Promise<ObjectId> {
	const _id = new ObjectId();
	const row: McpConnector = {
		_id,
		userId: owner.user._id,
		scope,
		name,
		url: "https://seed.test/mcp",
		auth: "none",
		createdAt: new Date(),
		updatedAt: new Date(),
	};
	await collections.mcpConnectors.insertOne(row);
	seeded.push(_id);
	return _id;
}

async function add(who: TestUser, name: string, scope: "user" | "deployment" = "user") {
	const res = await create({
		locals: who.locals,
		request: new Request("http://localhost/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name, url: "https://new.test/mcp", scope }),
		}),
	}).then(
		(r) => r,
		(err: { status?: number; body?: { message?: string } }) => err
	);
	if (res instanceof Response) {
		const body = (await res.json()) as { id?: string };
		if (body.id) seeded.push(new ObjectId(body.id));
		return { status: res.status, message: "" };
	}
	return {
		status: (res as { status?: number }).status ?? 500,
		message: (res as { body?: { message?: string } }).body?.message ?? "",
	};
}

async function rename(who: TestUser, id: ObjectId, name: string, deployment = false) {
	return act({
		locals: who.locals,
		params: { id: id.toString() },
		url: new URL(`http://localhost/api${deployment ? "?scope=deployment" : ""}`),
		request: new Request("http://localhost/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "update", name }),
		}),
	}).then(
		(r) => r.status,
		(err: { status?: number }) => err.status ?? 500
	);
}

describe("a user adding a connector", () => {
	it("is refused a name another of their connectors has, in any case or spacing", async () => {
		await seed(me, "My Notes");
		for (const name of ["My Notes", "my notes", "  MY   notes ", "My\tNotes"]) {
			const res = await add(me, name);
			expect(res.status).toBe(409);
			expect(res.message).toContain("already exists");
		}
	});
	it("is refused a deployment connector's name, a row or an .env server's", async () => {
		await seed(other, "Company Wiki", "deployment");
		expect((await add(me, "company wiki")).status).toBe(409);
		expect((await add(me, "ENV search")).status).toBe(409);
	});
	it("may reuse the name of another user's own connector, and any free name", async () => {
		await seed(other, "Theirs");
		expect((await add(me, "Theirs")).status).toBe(201);
		expect((await add(me, "Fresh")).status).toBe(201);
	});
});

describe("a user renaming a connector", () => {
	it("is refused a taken name, and may keep or re-case its own", async () => {
		await seed(me, "First");
		const second = await seed(me, "Second");
		await seed(other, "Wiki", "deployment");
		expect(await rename(me, second, "FIRST")).toBe(409);
		expect(await rename(me, second, "wiki")).toBe(409);
		expect(await rename(me, second, "Second")).toBe(200);
		expect(await rename(me, second, "SECOND")).toBe(200);
		expect(await rename(me, second, "Third")).toBe(200);
	});
});

describe("an administrator and deployment connectors", () => {
	it("is refused a clash with another deployment connector on create and rename", async () => {
		gate.admin = true;
		await seed(other, "Wiki", "deployment");
		expect((await add(me, " wiki ", "deployment")).status).toBe(409);
		expect((await add(me, "env SEARCH", "deployment")).status).toBe(409);
		const mine = await seed(me, "Tracker", "deployment");
		expect(await rename(me, mine, "WIKI", true)).toBe(409);
		expect(await rename(me, mine, "Tracker", true)).toBe(200);
		expect(await rename(me, mine, "Tracker 2", true)).toBe(200);
	});
	it("may add a deployment connector named like a user's own one: it wins at resolve time", async () => {
		gate.admin = true;
		await seed(other, "Shared name");
		expect((await add(me, "Shared name", "deployment")).status).toBe(201);
	});
});
