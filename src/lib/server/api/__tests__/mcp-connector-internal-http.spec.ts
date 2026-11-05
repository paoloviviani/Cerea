/**
 * A connector's address is https, except that an administrator may add one for everyone on a
 * host named in `MCP_INTERNAL_HOSTS` over plain http (a server on the compose network).
 *
 * Create and update, each with: the listed host accepted for a deployment connector, a host
 * that is not listed refused, a personal connector refused, and https unchanged. The connection
 * itself (a listed name over http, resolving to a private address only) is covered by the
 * `mcpFetch` tests in `urlSafety.test.ts`; the tool listing here is pointed at the mock.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { env } from "$env/dynamic/private";
import { collections, ready } from "$lib/server/database";
import type { McpConnector } from "$lib/types/McpConnector";
import { startMockMcp, type MockMcp } from "../../../../../tests/mock-mcp";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";

import { POST as postOne } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";
import { POST as create } from "../../../../routes/api/v2/mcp/connectors/+server";

const INTERNAL = "http://mcp-joplin:8081/mcp";
const REFUSED = /must be served over HTTPS \(or be a host listed in MCP_INTERNAL_HOSTS\)/;

let mock: MockMcp;
const originalHosts = env.MCP_INTERNAL_HOSTS;
const originalKey = process.env.CHAT_SECRET_KEY;
const realFetch = globalThis.fetch;
const seeded: ObjectId[] = [];

vi.mock("$lib/server/mcp/health", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/mcp/health")>();
	return {
		...actual,
		listTools: (_url: string, headers?: Record<string, string>, timeoutMs?: number) =>
			actual.listTools(mock.url, headers, timeoutMs),
	};
});

beforeAll(async () => {
	await ready;
	env.MCP_INTERNAL_HOSTS = "mcp-joplin";
	process.env.CHAT_SECRET_KEY ||= "mcp-connector-internal-http-spec";
	mock = await startMockMcp(0, {});
});

afterEach(async () => {
	vi.unstubAllGlobals();
	await collections.mcpConnectors.deleteMany({ _id: { $in: seeded.splice(0) } });
	await collections.mcpConnectors.deleteMany({ url: INTERNAL });
	await cleanupTestData();
});

afterAll(async () => {
	env.MCP_INTERNAL_HOSTS = originalHosts;
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
	else process.env.CHAT_SECRET_KEY = originalKey;
	await mock.close();
});

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

const update = (id: ObjectId, person: TestUser, body: Record<string, unknown>, query: string) =>
	postOne({
		locals: withToken(person),
		params: { id: id.toString() },
		url: new URL(`http://localhost/api/v2/mcp/connectors/${id}${query}`),
		request: new Request("http://localhost/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "update", ...body }),
		}),
	} as never);

async function seed(person: TestUser, scope: "user" | "deployment"): Promise<ObjectId> {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: person.user._id,
		scope,
		name: "Joplin",
		url: "https://joplin.example.test/mcp",
		auth: "none",
		createdAt: new Date(),
		updatedAt: new Date(),
	} as McpConnector);
	seeded.push(_id);
	return _id;
}

async function refused(promise: Response | Promise<Response>) {
	try {
		await promise;
		expect.fail("Should have thrown");
	} catch (e: unknown) {
		expect((e as { status: number }).status).toBe(400);
		expect(String((e as { body?: { message?: string } }).body?.message)).toMatch(REFUSED);
	}
}

describe.sequential("adding a connector over http to an internal host", () => {
	it("accepts a listed host for a connector everyone gets, each user bringing a key", async () => {
		const person = await createTestUser();
		stubAdminGateway(person.user._id);
		const response = await add(person, {
			name: "Joplin",
			url: INTERNAL,
			scope: "deployment",
			authMode: "user_key",
		});
		expect(response.status).toBe(201);
		expect((await collections.mcpConnectors.findOne({ url: INTERNAL }))?.scope).toBe("deployment");
	});

	it("refuses http to a host that is not listed", async () => {
		const person = await createTestUser();
		stubAdminGateway(person.user._id);
		await refused(
			add(person, {
				name: "x",
				url: "http://mcp-other:8081/mcp",
				scope: "deployment",
				authMode: "user_key",
			})
		);
	});

	it("refuses http for a personal connector, even to a listed host", async () => {
		const person = await createTestUser();
		await refused(add(person, { name: "x", url: INTERNAL, scope: "user", authMode: "none" }));
	});

	it("still takes https", async () => {
		const person = await createTestUser();
		stubAdminGateway(person.user._id);
		const response = await add(person, {
			name: "x",
			url: "https://joplin.example.test/mcp",
			scope: "deployment",
			authMode: "user_key",
		});
		expect(response.status).toBe(201);
		await collections.mcpConnectors.deleteMany({ url: "https://joplin.example.test/mcp" });
	});
});

describe.sequential("changing a connector's address to an internal host", () => {
	it("accepts a listed host on a deployment connector", async () => {
		const person = await createTestUser();
		const id = await seed(person, "deployment");
		stubAdminGateway(person.user._id);
		await update(id, person, { url: INTERNAL }, "?scope=deployment");
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.url).toBe(INTERNAL);
	});

	it("refuses a host that is not listed, and leaves the address alone", async () => {
		const person = await createTestUser();
		const id = await seed(person, "deployment");
		stubAdminGateway(person.user._id);
		await refused(update(id, person, { url: "http://mcp-other:8081/mcp" }, "?scope=deployment"));
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.url).toBe(
			"https://joplin.example.test/mcp"
		);
	});

	it("refuses a listed host on a personal connector", async () => {
		const person = await createTestUser();
		const id = await seed(person, "user");
		await refused(update(id, person, { url: INTERNAL }, ""));
	});

	it("still takes https", async () => {
		const person = await createTestUser();
		const id = await seed(person, "user");
		await update(id, person, { url: "https://other.example.test/mcp" }, "");
		expect((await collections.mcpConnectors.findOne({ _id: id }))?.url).toBe(
			"https://other.example.test/mcp"
		);
	});
});
