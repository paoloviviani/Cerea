/**
 * A deployment connector where each user brings their own key (`auth: "user-key"`).
 *
 * The administrator defines the connector (name, address, which header carries the key); each
 * user adds a key of their own, kept sealed in one `mcpTokens` row per user and sent only on
 * that user's calls. Driven against the real MCP mock with a per-user key guard
 * (`tests/mock-mcp.ts` with `header`), through the real routes and the real turn resolver.
 *
 * Every negative here sits next to a positive on the same data: a 404 or an absent key from a
 * query that matched nothing for an unrelated reason would pass any negative test.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { env } from "$env/dynamic/private";
import { collections, ready } from "$lib/server/database";
import { callMcpTool } from "$lib/server/mcp/httpClient";
import { getOpenAiToolsForMcp } from "$lib/server/mcp/tools";
import { resolveConnectors as resolveSelection } from "$lib/server/mcp/testing/resolveConnectors";
import { USER_KEYED_COLLECTIONS } from "$lib/server/identity/userKeyedCollections";
import type { McpConnector, McpConnectorView } from "$lib/types/McpConnector";
import { startMockMcp, type MockMcp } from "../../../../../tests/mock-mcp";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";

import { GET as LIST, POST as CREATE } from "../../../../routes/api/v2/mcp/connectors/+server";
import { DELETE, POST } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";

const KEY_A = "key-of-user-a-0123456789";
const KEY_B = "key-of-user-b-9876543210";
const HEADER = "X-Api-Key";

let mock: MockMcp;
let a: TestUser;
let b: TestUser;
let c: TestUser;
let admin: TestUser;
const originalInsecure = env.MCP_ALLOW_INSECURE_URLS;
const originalKey = process.env.CHAT_SECRET_KEY;
const seeded: ObjectId[] = [];
const realFetch = globalThis.fetch;

beforeAll(async () => {
	await ready;
	env.MCP_ALLOW_INSECURE_URLS = "true";
	process.env.CHAT_SECRET_KEY ||= "mcp-connector-user-key-spec";
	mock = await startMockMcp(0, { header: { name: HEADER, accepts: [KEY_A, KEY_B] } });
	[a, b, c, admin] = await Promise.all([
		createTestUser(),
		createTestUser(),
		createTestUser(),
		createTestUser(),
	]);
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await collections.mcpTokens.deleteMany({ connectorId: { $in: seeded } });
	await collections.mcpConnectors.deleteMany({ _id: { $in: seeded.splice(0) } });
	mock.reset();
});

afterAll(async () => {
	env.MCP_ALLOW_INSECURE_URLS = originalInsecure;
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
	else process.env.CHAT_SECRET_KEY = originalKey;
	await mock.close();
	await cleanupTestData();
});

/** The gateway says this caller administers the deployment; everything else (the mock) is real. */
function stubAdminGateway() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
			const target =
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (target.endsWith("/me")) return Response.json({ id: "admin", is_admin: true });
			return realFetch(input, init);
		})
	);
}
const asAdmin = (user: TestUser): App.Locals => ({ ...user.locals, token: "gateway-token" });

async function seed(fields: Partial<McpConnector> = {}): Promise<ObjectId> {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: admin.user._id,
		scope: "deployment",
		name: "keyed",
		url: mock.url,
		auth: "user-key",
		tokenHeader: HEADER,
		tokenPrefix: "",
		keyHelpText: "Create a token in your settings.",
		keyHelpUrl: "https://example.test/tokens",
		createdAt: new Date(),
		updatedAt: new Date(),
		...fields,
	});
	seeded.push(_id);
	return _id;
}

async function act(
	user: TestUser,
	id: ObjectId,
	body: Record<string, unknown>,
	options: { admin?: boolean } = {}
): Promise<{ status: number; body: McpConnectorView & { message?: string } }> {
	if (options.admin) stubAdminGateway();
	try {
		const response = await POST({
			locals: options.admin ? asAdmin(user) : user.locals,
			params: { id: id.toString() },
			url: new URL(
				`http://localhost/api/v2/mcp/connectors/${id}${options.admin ? "?scope=deployment" : ""}`
			),
			request: new Request("http://localhost/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		} as never);
		return { status: response.status, body: await response.json() };
	} catch (err) {
		const e = err as { status?: number; body?: { message?: string } };
		return { status: e.status ?? 500, body: { message: e.body?.message } as never };
	}
}

async function list(
	user: TestUser,
	options: { admin?: boolean } = {}
): Promise<McpConnectorView[]> {
	if (options.admin) stubAdminGateway();
	const response = await LIST({
		locals: options.admin ? asAdmin(user) : user.locals,
		url: new URL(`http://localhost/api/v2/mcp/connectors${options.admin ? "?admin=1" : ""}`),
	} as never);
	return ((await response.json()) as { data: McpConnectorView[] }).data;
}

const setKey = (user: TestUser, id: ObjectId, key: string) =>
	act(user, id, { action: "setKey", key });

describe("publishing a connector where each user brings their own key", () => {
	it("is created by an administrator with no key on it, and a non-administrator cannot", async () => {
		stubAdminGateway();
		const create = (user: TestUser, locals: App.Locals, body: Record<string, unknown>) =>
			Promise.resolve(
				CREATE({
					locals,
					request: new Request("http://localhost/api", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify(body),
					}),
				} as never)
			).then(
				async (r) => ({ status: r.status, body: await r.json() }),
				(err: { status?: number }) => ({ status: err.status ?? 500, body: null })
			);
		const body = {
			name: "GitHub",
			url: "https://mcp.example.test/mcp",
			authMode: "user_key",
			scope: "deployment",
			tokenHeader: "X-Api-Key",
			keyHelpText: "Create a token with the repo scope.",
			keyHelpUrl: "https://example.test/tokens",
		};

		const refused = await create(a, a.locals, body);
		expect([401, 403]).toContain(refused.status);
		expect(await collections.mcpConnectors.countDocuments({ name: "GitHub" })).toBe(0);

		const made = await create(admin, asAdmin(admin), body);
		expect(made.status).toBe(201);
		const row = await collections.mcpConnectors.findOne({ name: "GitHub", scope: "deployment" });
		if (row) seeded.push(row._id);
		expect(row?.auth).toBe("user-key");
		expect(row?.tokenSealed).toBeUndefined();
		expect(row?.tokenHeader).toBe("X-Api-Key");
		expect(row?.tokenPrefix).toBe("");
		expect(row?.keyHelpText).toBe("Create a token with the repo scope.");
		expect(row?.keyHelpUrl).toBe("https://example.test/tokens");
		expect(await collections.mcpTokens.countDocuments({ connectorId: row?._id })).toBe(0);
	});

	it("sends the key as Authorization: Bearer by default, and refuses a plain-http help link", async () => {
		stubAdminGateway();
		const create = (body: Record<string, unknown>) =>
			Promise.resolve(
				CREATE({
					locals: asAdmin(admin),
					request: new Request("http://localhost/api", {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							name: "Default header",
							url: "https://mcp.example.test/mcp",
							authMode: "user_key",
							scope: "deployment",
							...body,
						}),
					}),
				} as never)
			).then(
				async (r) => ({ status: r.status }),
				(err: { status?: number }) => ({ status: err.status ?? 500 })
			);
		expect((await create({ keyHelpUrl: "http://example.test/t" })).status).toBe(400);
		expect((await create({ authMode: "user_key", scope: "user" })).status).toBe(400);
		expect((await create({})).status).toBe(201);
		const row = await collections.mcpConnectors.findOne({ name: "Default header" });
		if (row) seeded.push(row._id);
		// No header named: the connector leaves it unset and the sender's default (Authorization, Bearer) applies.
		expect(row?.tokenHeader).toBeUndefined();
		expect(row?.tokenPrefix).toBeUndefined();
	});
});

describe("a user's own key", () => {
	it("is stored sealed, is never sent back, and lists the tools with that user's key", async () => {
		const id = await seed();
		const before = await list(a);
		expect(before.find((v) => v.id === id.toString())).toMatchObject({
			auth: "user-key",
			connected: false,
			keyHelpText: "Create a token in your settings.",
		});

		const saved = await setKey(a, id, KEY_A);
		expect(saved.status).toBe(200);
		expect(saved.body.connected).toBe(true);
		expect(saved.body.keyRefused).toBeUndefined();
		// The first check seeds the shared tool list, with a's own key.
		expect(saved.body.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "add"]));

		const row = await collections.mcpTokens.findOne({ connectorId: id, userId: a.user._id });
		expect(row?.accessTokenSealed).toMatch(/^v1:/);
		expect(JSON.stringify(row)).not.toContain(KEY_A);
		const views = JSON.stringify(await list(a));
		expect(views).not.toContain(KEY_A);
		expect(JSON.stringify(saved.body)).not.toContain(KEY_A);
		// The connector row never holds it either.
		expect(JSON.stringify(await collections.mcpConnectors.findOne({ _id: id }))).not.toContain(
			KEY_A
		);
	});

	it("is used only by its owner: each user's turn carries their own key, and nobody else's", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);

		const forA = await resolveSelection({ connectorIds: [id.toString()], userId: a.user._id });
		expect(forA.servers).toHaveLength(1);
		expect(forA.servers[0].headers).toEqual({ [HEADER]: KEY_A });

		// b has no key: the connector is not offered, and is named as needing one.
		const forB = await resolveSelection({ connectorIds: [id.toString()], userId: b.user._id });
		expect(forB.servers).toEqual([]);
		expect(forB.needAuthorization).toEqual(["keyed"]);

		await setKey(b, id, KEY_B);
		const bothA = await resolveSelection({ connectorIds: [id.toString()], userId: a.user._id });
		const bothB = await resolveSelection({ connectorIds: [id.toString()], userId: b.user._id });
		expect(bothA.servers[0].headers).toEqual({ [HEADER]: KEY_A });
		expect(bothB.servers[0].headers).toEqual({ [HEADER]: KEY_B });

		// And a real tool call over the wire carries the caller's own key.
		const toolsA = await getOpenAiToolsForMcp(bothA.servers);
		const toolsB = await getOpenAiToolsForMcp(bothB.servers);
		expect(toolsA.unavailable).toEqual([]);
		expect(toolsB.unavailable).toEqual([]);
		expect(toolsA.tools.map((t) => t.function.name)).toContain("echo");

		// A tool call over the wire arrives with the caller's own key, and only that.
		mock.reset();
		await callMcpTool(bothA.servers[0], "echo", { text: "from a" });
		await callMcpTool(bothB.servers[0], "echo", { text: "from b" });
		expect(mock.calls().map((call) => [call.args.text, call.credential])).toEqual([
			["from a", KEY_A],
			["from b", KEY_B],
		]);
	});

	it("is offered no tools to a user without a key, and not at all in the listing the model sees", async () => {
		const id = await seed({ tools: [{ name: "echo" }] });
		await setKey(a, id, KEY_A);
		const locals = await (await import("$lib/server/mcp/selection")).mcpLocalsFor({}, b.user._id);
		expect(locals.connectors.map((x) => x.name)).not.toContain("keyed");
		expect(locals.blocked).toContainEqual(
			expect.objectContaining({ name: "keyed", reason: "needs sign-in" })
		);
		const own = await (await import("$lib/server/mcp/selection")).mcpLocalsFor({}, a.user._id);
		expect(own.connectors.map((x) => x.name)).toContain("keyed");
	});

	it("is replaced by saving another, and removed (for that user only) by Remove key", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);
		await setKey(b, id, KEY_B);

		const replaced = await setKey(a, id, KEY_B);
		expect(replaced.body.connected).toBe(true);
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: a.user._id })
		).toBe(1);

		const removed = await act(a, id, { action: "disconnect" });
		expect(removed.body.connected).toBe(false);
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: a.user._id })
		).toBe(0);
		// b's is untouched.
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: b.user._id })
		).toBe(1);
		const forA = await resolveSelection({ connectorIds: [id.toString()], userId: a.user._id });
		expect(forA.servers).toEqual([]);
	});

	it("says it was refused when the server answers 401, hides it from chats, and Replace clears it", async () => {
		const id = await seed();
		const bad = await setKey(c, id, "a-key-the-server-does-not-know");
		expect(bad.status).toBe(200);
		expect(bad.body.keyRefused).toBe(true);
		expect(bad.body.connected).toBe(false);
		// No server detail reaches a non-administrator.
		expect(bad.body.lastError).toBeUndefined();
		// Look for the status in what the server could have written, not in the whole body: the
		// connector's random id and port can contain "401" by chance (a flake seen in CI).
		const served = Object.fromEntries(
			Object.entries(bad.body).filter(([k]) => k !== "id" && k !== "url")
		);
		expect(JSON.stringify(served)).not.toMatch(/\b401\b|unauthori[sz]ed/i);
		const resolved = await resolveSelection({ connectorIds: [id.toString()], userId: c.user._id });
		expect(resolved.servers).toEqual([]);

		const fixed = await setKey(c, id, KEY_A);
		expect(fixed.body.keyRefused).toBeUndefined();
		expect(fixed.body.connected).toBe(true);
		const again = await resolveSelection({ connectorIds: [id.toString()], userId: c.user._id });
		expect(again.servers).toHaveLength(1);
	});

	it("Check key re-tests the user's own key and notices a refusal", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);
		expect((await act(a, id, { action: "checkKey" })).body.connected).toBe(true);
		// The service revokes it: a changed accepted list stands in for that.
		await collections.mcpTokens.updateOne(
			{ connectorId: id, userId: a.user._id },
			{ $set: { accessTokenSealed: await sealed("revoked") } }
		);
		const after = await act(a, id, { action: "checkKey" });
		expect(after.body.keyRefused).toBe(true);
		// Check key with no key is a plain 400.
		expect((await act(b, id, { action: "checkKey" })).status).toBe(400);
	});

	it("is refused on a connector that does not take one", async () => {
		const id = await seed({ auth: "none", tokenHeader: undefined });
		expect((await setKey(a, id, KEY_A)).status).toBe(400);
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(0);
	});
});

async function sealed(plain: string) {
	return (await import("$lib/server/mcp/secretBox")).seal(plain);
}

describe("who sees what", () => {
	it("gives the administrator a count of users with a key, and nobody else any count", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);
		await setKey(b, id, KEY_B);

		const adminView = (await list(admin, { admin: true })).find((v) => v.id === id.toString());
		expect(adminView?.keyCount).toBe(2);
		// A count, never a key and never who.
		const adminJson = JSON.stringify(adminView);
		for (const secret of [KEY_A, KEY_B, a.user._id.toString(), b.user._id.toString()]) {
			expect(adminJson).not.toContain(secret);
		}
		// The administrator hasn't added one: their own card says so.
		expect(adminView?.connected).toBe(false);

		const aView = (await list(a)).find((v) => v.id === id.toString());
		expect(aView?.keyCount).toBeUndefined();
		expect(aView?.connected).toBe(true);
		// Not even an administrator sees the count outside their own screen.
		const adminInWorkspace = (await list(admin)).find((v) => v.id === id.toString());
		expect(adminInWorkspace?.keyCount).toBeUndefined();
	});

	it("keeps one user's refusal off another's card", async () => {
		const id = await seed();
		await setKey(c, id, "unknown-key");
		await setKey(a, id, KEY_A);
		expect((await list(c)).find((v) => v.id === id.toString())?.keyRefused).toBe(true);
		const aView = (await list(a)).find((v) => v.id === id.toString());
		expect(aView?.keyRefused).toBeUndefined();
		expect(aView?.connected).toBe(true);
		expect((await list(b)).find((v) => v.id === id.toString())).toMatchObject({ connected: false });
	});

	it("does not let a user change the connector: only their own key", async () => {
		const id = await seed();
		expect((await act(a, id, { action: "update", name: "mine now" })).status).toBe(404);
		expect((await act(a, id, { action: "check" })).status).toBe(404);
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.name).toBe("keyed");
		// The same data, positive side: the administrator on the admin screen does.
		const renamed = await act(admin, id, { action: "update", name: "renamed" }, { admin: true });
		expect(renamed.status).toBe(200);
		expect(renamed.body.name).toBe("renamed");
	});
});

describe("the administrator's check", () => {
	it("lists the tools with a test key typed at check time, and stores no key", async () => {
		const id = await seed();
		const checked = await act(admin, id, { action: "check", testKey: KEY_A }, { admin: true });
		expect(checked.status).toBe(200);
		expect(checked.body.tools?.map((t) => t.name)).toEqual(expect.arrayContaining(["echo", "add"]));
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(0);
		const row = await collections.mcpConnectors.findOne({ _id: id });
		expect(JSON.stringify(row)).not.toContain(KEY_A);
	});

	it("says what to do when there is neither a test key nor a key of the administrator's own", async () => {
		const id = await seed();
		const none = await act(admin, id, { action: "check" }, { admin: true });
		expect(none.status).toBe(400);
		expect(none.body.message).toMatch(/test key/i);
		// With a key of their own it needs no test key.
		await setKey(admin, id, KEY_B);
		expect((await act(admin, id, { action: "check" }, { admin: true })).status).toBe(200);
	});

	it("reports a refused test key as the connector's error, to the administrator", async () => {
		const id = await seed();
		const refused = await act(admin, id, { action: "check", testKey: "nope" }, { admin: true });
		expect(refused.status).toBe(200);
		expect(refused.body.lastError).toBeTruthy();
		// The same row, read by a user: only the generic line.
		const asUser = (await list(a)).find((v) => v.id === id.toString());
		expect(asUser?.lastError).toBe("Could not list its tools");
	});
});

describe("removing and changing the connector", () => {
	it("removing it removes every user's key", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);
		await setKey(b, id, KEY_B);
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(2);

		stubAdminGateway();
		const response = await DELETE({
			locals: asAdmin(admin),
			params: { id: id.toString() },
			url: new URL(`http://localhost/api/v2/mcp/connectors/${id}?scope=deployment`),
		} as never);
		expect(response.status).toBe(204);
		expect(await collections.mcpConnectors.countDocuments({ _id: id })).toBe(0);
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(0);
	});

	it("a new address drops every key (a key must not follow the connector to another host), a new header keeps them", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);
		const header = await act(
			admin,
			id,
			{ action: "update", tokenHeader: "X-Other" },
			{ admin: true }
		);
		expect(header.status).toBe(200);
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(1);
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.tokenHeader).toBe("X-Other");

		await act(
			admin,
			id,
			{ action: "update", url: "https://elsewhere.example.test/mcp" },
			{ admin: true }
		);
		expect(await collections.mcpTokens.countDocuments({ connectorId: id })).toBe(0);
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.auth).toBe("user-key");
	});

	it("will not turn into a shared key by someone sending a token", async () => {
		const id = await seed();
		const res = await act(admin, id, { action: "update", token: "shared" }, { admin: true });
		expect(res.status).toBe(400);
		const row = await collections.mcpConnectors.findOne({ _id: id });
		expect(row?.auth).toBe("user-key");
		expect(row?.tokenSealed).toBeUndefined();
	});
});

describe("identity merge and erasure", () => {
	const entry = () => {
		const found = USER_KEYED_COLLECTIONS.find((e) => e.name === "mcpTokens");
		if (!found) throw new Error("mcpTokens must be registered");
		return found;
	};

	it("merge moves the stray's key to the target, erase removes only that user's keys", async () => {
		const id = await seed();
		await setKey(a, id, KEY_A);
		await setKey(b, id, KEY_B);

		await entry().merge(a.user._id, c.user._id);
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: c.user._id })
		).toBe(1);
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: a.user._id })
		).toBe(0);
		// c now uses the key that was a's.
		const forC = await resolveSelection({ connectorIds: [id.toString()], userId: c.user._id });
		expect(forC.servers[0].headers).toEqual({ [HEADER]: KEY_A });

		await entry().erase(b.user._id, { conversationIds: [] });
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: b.user._id })
		).toBe(0);
		expect(
			await collections.mcpTokens.countDocuments({ connectorId: id, userId: c.user._id })
		).toBe(1);
	});
});
