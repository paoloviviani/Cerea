/**
 * `GET | PUT /api/v2/code/connectors` (ADR 0108, item 3): a coding session's connector opt-in,
 * owner only, default none, refusing a connector that is not the caller's.
 */
import { ObjectId } from "mongodb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { seal } from "$lib/server/mcp/secretBox";
import { GET, PUT } from "./+server";

vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeAgentsEnabled: () => true,
	codeAgentsAllowedFor: async () => true,
}));

beforeAll(async () => {
	await ready;
}, 30000);

type Person = Awaited<ReturnType<typeof createTestUser>>;
let owner: Person;
let other: Person;
let deviceId: string;
let mine: string;
let theirs: string;

async function connector(userId: ObjectId, name: string): Promise<string> {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId,
		scope: "user",
		name,
		url: `https://${name.toLowerCase()}.test/mcp`,
		auth: "token",
		tokenSealed: seal("secret-token"),
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return `connector:${_id}`;
}

beforeEach(async () => {
	owner = await createTestUser();
	other = await createTestUser();
	const _id = new ObjectId();
	deviceId = _id.toString();
	await collections.codeDevices.insertOne({
		_id,
		userId: owner.user._id,
		machineId: `m-${_id}`,
		status: "paired",
		name: "studio",
	} as never);
	mine = await connector(owner.user._id, "Mine");
	theirs = await connector(other.user._id, "Theirs");
});

afterEach(async () => {
	await collections.mcpConnectors.deleteMany({});
	await collections.codeSessionConnectors.deleteMany({});
	await collections.codeDevices.deleteMany({});
	await cleanupTestData();
});

const get = (locals: App.Locals, session = "s1", device = deviceId) =>
	testRequest(GET, {
		path: `/api/v2/code/connectors?device=${device}&session=${session}`,
		locals,
	});
const put = (locals: App.Locals, body: unknown) =>
	testRequest(PUT, {
		path: "/api/v2/code/connectors",
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		locals,
	});

/** superjson bodies carry the value under `json`. */
const read = async (res: Response) => {
	const body = await res.json();
	return (body && typeof body === "object" && "json" in body ? body.json : body) as {
		options: Array<{ key: string; name: string }>;
		selected: string[];
	};
};

describe("/api/v2/code/connectors", () => {
	it("offers the caller's connectors only, with none selected by default", async () => {
		const res = await get(owner.locals);
		expect(res.status).toBe(200);
		const body = await read(res);
		expect(body.options.map((o) => o.name)).toEqual(["Mine"]);
		expect(body.selected).toEqual([]);
		expect(JSON.stringify(body)).not.toContain("secret-token");
	});

	it("saves a selection and reads it back; an empty list clears it", async () => {
		expect((await put(owner.locals, { deviceId, sessionId: "s1", keys: [mine] })).status).toBe(200);
		expect((await read(await get(owner.locals))).selected).toEqual([mine]);
		expect((await read(await get(owner.locals, "s2"))).selected).toEqual([]);
		await put(owner.locals, { deviceId, sessionId: "s1", keys: [] });
		expect((await read(await get(owner.locals))).selected).toEqual([]);
	});

	it("refuses another user's connector and leaves the selection as it was", async () => {
		await put(owner.locals, { deviceId, sessionId: "s1", keys: [mine] });
		expect((await put(owner.locals, { deviceId, sessionId: "s1", keys: [theirs] })).status).toBe(
			400
		);
		expect((await read(await get(owner.locals))).selected).toEqual([mine]);
	});

	it("is a 404 on somebody else's machine, for a read and for a write", async () => {
		expect((await get(other.locals)).status).toBe(404);
		expect((await put(other.locals, { deviceId, sessionId: "s1", keys: [theirs] })).status).toBe(
			404
		);
		expect((await put(owner.locals, { deviceId, keys: [] })).status).toBe(400);
	});
});
