/**
 * Deployment connectors are changed only on the Admin screen, and every
 * connector's tools are listed automatically.
 *
 * - Workspace never gets `manageable` on a deployment row, administrators
 *   included; the admin listing (`?admin=1`) does.
 * - A change (update, re-probe, check) to a deployment row is refused unless
 *   the request says it comes from the administrator's screen
 *   (`?scope=deployment`), and refused outright for anybody else.
 * - Adding a connector, and changing its address or key, lists its tools, or
 *   records why it could not.
 *
 * The tool listing goes to a real MCP server (`tests/mock-mcp.ts` with a
 * token): the connectors' addresses must be https, so `listTools` is pointed
 * at the mock's own address and everything else about it is real.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { env } from "$env/dynamic/private";
import { collections, ready } from "$lib/server/database";
import { seal } from "$lib/server/mcp/secretBox";
import { viewsFor } from "$lib/server/mcp/connectors";
import { summaryOf } from "$lib/server/mcp/turnConnectors";
import type { McpConnector } from "$lib/types/McpConnector";
import { startMockMcp, type MockMcp } from "../../../../../tests/mock-mcp";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";

import { POST as postOne } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";
import { GET as listAll, POST as create } from "../../../../routes/api/v2/mcp/connectors/+server";

const TOKEN = "right-token";
const ADDRESS = "https://find.example.test/mcp";

let mock: MockMcp;
const originalInsecure = env.MCP_ALLOW_INSECURE_URLS;
const originalKey = process.env.CHAT_SECRET_KEY;
const realFetch = globalThis.fetch;
const seeded: ObjectId[] = [];

vi.mock("$lib/server/mcp/health", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/mcp/health")>();
	return {
		...actual,
		// Every connector here has an https address; the one server answering is the mock.
		listTools: (_url: string, headers?: Record<string, string>) =>
			actual.listTools(mockUrl(), headers),
	};
});
let mockAddress = "";
const mockUrl = () => mockAddress;

beforeAll(async () => {
	await ready;
	env.MCP_ALLOW_INSECURE_URLS = "true";
	process.env.CHAT_SECRET_KEY ||= "mcp-connector-admin-edit-spec";
	mock = await startMockMcp(0, { token: TOKEN });
	mockAddress = mock.url;
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await collections.mcpConnectors.deleteMany({ _id: { $in: seeded.splice(0) } });
	await collections.mcpConnectors.deleteMany({ url: ADDRESS });
	await cleanupTestData();
});

afterAll(async () => {
	env.MCP_ALLOW_INSECURE_URLS = originalInsecure;
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
	else process.env.CHAT_SECRET_KEY = originalKey;
	await mock.close();
});

/** The gateway says this caller is an administrator; every other request goes through. */
function stubAdminGateway(adminId: ObjectId) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
			String(input instanceof Request ? input.url : input).endsWith("/me")
				? Response.json({ id: adminId.toString(), is_admin: true })
				: realFetch(input, init)
		)
	);
}

const withToken = (user: TestUser): App.Locals => ({ ...user.locals, token: "gateway-token" });

async function seed(user: TestUser, fields: Partial<McpConnector>): Promise<ObjectId> {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: user.user._id,
		scope: "deployment",
		name: "Find locations",
		url: ADDRESS,
		auth: "token",
		tokenSealed: seal(TOKEN),
		createdAt: new Date(),
		updatedAt: new Date(),
		...fields,
	});
	seeded.push(_id);
	return _id;
}

function act(id: ObjectId, locals: App.Locals, body: Record<string, unknown>, query = "") {
	return postOne({
		locals,
		params: { id: id.toString() },
		url: new URL(`http://localhost/api/v2/mcp/connectors/${id}${query}`),
		request: new Request("http://localhost/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never);
}

async function expectStatus(promise: Response | Promise<Response>, status: number) {
	try {
		await promise;
		expect.fail("Should have thrown");
	} catch (e: unknown) {
		expect((e as { status: number }).status).toBe(status);
	}
}

const list = async (locals: App.Locals, query = "") => {
	const response = await listAll({
		locals,
		url: new URL(`http://localhost/api/v2/mcp/connectors${query}`),
	} as never);
	return ((await response.json()) as { data: { id: string; manageable: boolean }[] }).data;
};

describe.sequential("a deployment connector is read-only outside Admin", () => {
	it("is not manageable in Workspace for an administrator, and is in the admin listing", async () => {
		const person = await createTestUser();
		const id = await seed(person, {});
		stubAdminGateway(person.user._id);
		const locals = withToken(person);

		const workspace = (await list(locals)).find((c) => c.id === id.toString());
		expect(workspace?.manageable).toBe(false);
		const admin = (await list(locals, "?admin=1")).find((c) => c.id === id.toString());
		expect(admin?.manageable).toBe(true);
		// The view helper itself, as the listing calls it.
		const direct = await viewsFor(person.user._id, true, false);
		expect(direct.find((c) => c.id === id.toString())?.manageable).toBe(false);
	});

	it("refuses an administrator's update, re-probe and check from Workspace, and allows them from Admin", async () => {
		const person = await createTestUser();
		const id = await seed(person, {});
		stubAdminGateway(person.user._id);
		const locals = withToken(person);

		for (const action of ["update", "reprobe", "check"]) {
			await expectStatus(act(id, locals, { action, name: "Renamed" }), 403);
		}
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.name).toBe("Find locations");

		const response = await act(
			id,
			locals,
			{ action: "update", name: "Renamed" },
			"?scope=deployment"
		);
		expect(response.status).toBe(200);
		expect(((await response.json()) as { name: string; manageable: boolean }).manageable).toBe(
			true
		);
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.name).toBe("Renamed");
	});

	it("refuses somebody who is not an administrator, even with the Admin query", async () => {
		const owner = await createTestUser();
		const stranger = await createTestUser();
		const id = await seed(owner, {});
		await expectStatus(
			act(id, stranger.locals, { action: "update", name: "Hijacked" }, "?scope=deployment"),
			404
		);
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.name).toBe("Find locations");
	});
});

describe.sequential("an administrator edits a connector", () => {
	it("saves name, address, description and a new key, and clears the description", async () => {
		const person = await createTestUser();
		const id = await seed(person, { description: "Old." });
		stubAdminGateway(person.user._id);
		const locals = withToken(person);

		const response = await act(
			id,
			locals,
			{
				action: "update",
				name: "Places",
				url: "https://places.example.test/mcp",
				description: "Finds places and addresses.",
				token: "another-key",
				tokenHeader: "X-API-Key",
				tokenPrefix: "",
			},
			"?scope=deployment"
		);
		expect(response.status).toBe(200);
		const row = await collections.mcpConnectors.findOne({ _id: id });
		expect(row).toMatchObject({
			name: "Places",
			url: "https://places.example.test/mcp",
			description: "Finds places and addresses.",
			tokenHeader: "X-API-Key",
			tokenPrefix: "",
		});
		expect(row?.tokenSealed).not.toBe(seal(TOKEN));

		await act(id, locals, { action: "update", description: "" }, "?scope=deployment");
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.description).toBeUndefined();
	});

	it("lists the tools again when the key changes, and records the failure of a wrong one", async () => {
		const person = await createTestUser();
		const id = await seed(person, { tokenSealed: seal("stale"), tools: [] });
		stubAdminGateway(person.user._id);
		const locals = withToken(person);

		await act(id, locals, { action: "update", token: "wrong-key" }, "?scope=deployment");
		const failed = await collections.mcpConnectors.findOne({ _id: id });
		expect(failed?.tools).toEqual([]);
		expect(failed?.lastError).toBeTruthy();
		expect(failed?.checkedAt).toBeInstanceOf(Date);

		await act(id, locals, { action: "update", token: TOKEN }, "?scope=deployment");
		const fixed = await collections.mcpConnectors.findOne({ _id: id });
		expect((fixed?.tools ?? []).map((t) => t.name)).toEqual(["echo", "add"]);
		expect(fixed?.lastError).toBeUndefined();
	});

	it("lists the tools again when the address changes", async () => {
		const person = await createTestUser();
		const id = await seed(person, { tools: [{ name: "stale" }], checkedAt: new Date(0) });
		stubAdminGateway(person.user._id);
		await act(
			id,
			withToken(person),
			{ action: "update", url: "https://elsewhere.example.test/mcp" },
			"?scope=deployment"
		);
		const row = await collections.mcpConnectors.findOne({ _id: id });
		expect((row?.tools ?? []).map((t) => t.name)).toEqual(["echo", "add"]);
	});
});

describe.sequential("adding a connector lists its tools", () => {
	const add = (person: TestUser, body: Record<string, unknown>) =>
		create({
			locals: withToken(person),
			url: new URL("http://localhost/api/v2/mcp/connectors"),
			request: new Request("http://localhost/api", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		} as never);

	it("stores the tools of one added with a shared key, and its description", async () => {
		const person = await createTestUser();
		stubAdminGateway(person.user._id);
		const response = await add(person, {
			name: "Find locations",
			url: ADDRESS,
			scope: "deployment",
			authMode: "token",
			token: TOKEN,
			description: "Finds places.",
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as { tools?: { name: string }[]; description?: string };
		expect((body.tools ?? []).map((t) => t.name)).toEqual(["echo", "add"]);
		expect(body.description).toBe("Finds places.");
		const row = await collections.mcpConnectors.findOne({ url: ADDRESS });
		expect((row?.tools ?? []).length).toBe(2);
	});

	it("keeps the connector and shows the error when the key is wrong", async () => {
		const person = await createTestUser();
		stubAdminGateway(person.user._id);
		const response = await add(person, {
			name: "Find locations",
			url: ADDRESS,
			scope: "deployment",
			authMode: "token",
			token: "wrong-key",
		});
		expect(response.status).toBe(201);
		const body = (await response.json()) as { tools?: unknown[]; lastError?: string };
		expect(body.tools).toEqual([]);
		expect(body.lastError).toBeTruthy();
	});
});

describe("the assistant's line for a connector with no stored tools", () => {
	it("says the tools have not been checked", () => {
		expect(summaryOf(undefined, [])).toBe("its tools haven't been checked; load it to see them.");
	});
});
