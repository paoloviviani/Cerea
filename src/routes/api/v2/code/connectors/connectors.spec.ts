/**
 * `GET | PUT /api/v2/code/connectors`: what a coding session inherits from the user's one
 * connector list, and its per-session narrowing (it only turns items off). Owner only.
 */
import { ObjectId } from "mongodb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { seal } from "$lib/server/mcp/secretBox";
import { setUserList } from "$lib/server/code/sessionConnectors";
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
	it("offers a session what it inherits from the user's one list: nothing until they list something", async () => {
		const empty = await read(await get(owner.locals));
		expect(empty.options).toEqual([]);
		expect(empty.selected).toEqual([]);
		await setUserList(owner.user._id, { keys: [mine] });
		const res = await get(owner.locals);
		expect(res.status).toBe(200);
		const body = await read(res);
		expect(body.options.map((o) => o.name)).toEqual(["Mine"]);
		// Everything inherited is on by default.
		expect(body.selected).toEqual([mine]);
		expect(JSON.stringify(body)).not.toContain("secret-token");
	});

	it("saves a narrowing per session and reads it back; all on again clears it", async () => {
		await setUserList(owner.user._id, { keys: [mine] });
		expect((await put(owner.locals, { deviceId, sessionId: "s1", keys: [] })).status).toBe(200);
		expect((await read(await get(owner.locals))).selected).toEqual([]);
		// Another session is untouched.
		expect((await read(await get(owner.locals, "s2"))).selected).toEqual([mine]);
		await put(owner.locals, { deviceId, sessionId: "s1", keys: [mine] });
		expect((await read(await get(owner.locals))).selected).toEqual([mine]);
	});

	it("never widens: a connector outside the user's list is refused and the narrowing stays", async () => {
		await setUserList(owner.user._id, { keys: [mine] });
		await put(owner.locals, { deviceId, sessionId: "s1", keys: [] });
		expect((await put(owner.locals, { deviceId, sessionId: "s1", keys: [theirs] })).status).toBe(
			400
		);
		expect((await read(await get(owner.locals))).selected).toEqual([]);
	});

	it("is a 404 on somebody else's machine, for a read and for a write", async () => {
		expect((await get(other.locals)).status).toBe(404);
		expect((await put(other.locals, { deviceId, sessionId: "s1", keys: [theirs] })).status).toBe(
			404
		);
		expect((await put(owner.locals, { deviceId, keys: [] })).status).toBe(400);
	});
});
