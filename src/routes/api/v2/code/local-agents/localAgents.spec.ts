/**
 * `GET | PUT /api/v2/code/local-agents`: the user's ONE list of connectors their agents may use
 * (sessions inherit it; apps on their computers use it while the switch is on), and that switch.
 * The caller's list only, default none, refusing a connector that is not the caller's.
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
	mine = await connector(owner.user._id, "Mine");
	theirs = await connector(other.user._id, "Theirs");
});

afterEach(async () => {
	await collections.mcpConnectors.deleteMany({});
	await collections.codeSessionConnectors.deleteMany({});
	await cleanupTestData();
});

const get = (locals: App.Locals) => testRequest(GET, { path: "/api/v2/code/local-agents", locals });
const put = (locals: App.Locals, body: unknown) =>
	testRequest(PUT, {
		path: "/api/v2/code/local-agents",
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		locals,
	});

describe("/api/v2/code/local-agents", () => {
	it("offers the caller's connectors only, none selected by default, and never a secret", async () => {
		const res = await get(owner.locals);
		expect(res.status).toBe(200);
		const text = await res.text();
		const body = JSON.parse(text) as { options: Array<{ name: string }>; selected: string[] };
		expect(body.options.map((o) => o.name)).toEqual(["Mine"]);
		expect(body.selected).toEqual([]);
		expect(text).not.toContain("secret-token");
	});

	it("saves a selection per user and reads it back; an empty list clears it", async () => {
		expect((await put(owner.locals, { keys: [mine] })).status).toBe(200);
		expect(((await (await get(owner.locals)).json()) as { selected: string[] }).selected).toEqual([
			mine,
		]);
		expect(((await (await get(other.locals)).json()) as { selected: string[] }).selected).toEqual(
			[]
		);
		await put(owner.locals, { keys: [] });
		expect(((await (await get(owner.locals)).json()) as { selected: string[] }).selected).toEqual(
			[]
		);
	});

	it("has the apps-on-my-computers switch on by default, changes it alone, and keeps the list", async () => {
		type Body = { selected: string[]; appsToo: boolean };
		await put(owner.locals, { keys: [mine] });
		expect(((await (await get(owner.locals)).json()) as Body).appsToo).toBe(true);
		const off = (await (await put(owner.locals, { appsToo: false })).json()) as Body;
		expect(off).toEqual({ selected: [mine], appsToo: false });
		const again = (await (await get(owner.locals)).json()) as Body;
		expect(again).toMatchObject({ selected: [mine], appsToo: false });
		// Saving the list does not turn the switch back on.
		await put(owner.locals, { keys: [] });
		expect(((await (await get(owner.locals)).json()) as Body).appsToo).toBe(false);
	});

	it("refuses another user's connector and a malformed body", async () => {
		await put(owner.locals, { keys: [mine] });
		expect((await put(owner.locals, { keys: [theirs] })).status).toBe(400);
		expect((await put(owner.locals, { nope: 1 })).status).toBe(400);
		expect(((await (await get(owner.locals)).json()) as { selected: string[] }).selected).toEqual([
			mine,
		]);
	});
});
