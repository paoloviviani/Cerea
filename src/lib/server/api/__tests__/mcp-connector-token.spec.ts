/**
 * A connector for an MCP server that takes a static token, end to end (ADR 0064).
 *
 * Driven against a real MCP server (`tests/mock-mcp.ts` with `token`), which
 * refuses anything without `Authorization: Bearer <token>` the way an API-key
 * server does: a bare 401, HTML body, no `WWW-Authenticate`, and no
 * protected-resource metadata. OAuth discovery sees nothing past that, and the
 * defect this file pins down is what the connector did next — **Re-check ran
 * the anonymous probe**, so a connector holding a perfectly good token showed
 * "it asks for authentication but publishes no resource metadata" and never
 * listed a tool, and pasting a token left that error on the row.
 *
 * Every connector here is seeded straight into the collection, because the
 * create route requires `https://` and the mock is local; the routes under
 * test are the ones a row's buttons call.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ObjectId } from "mongodb";
import { env } from "$env/dynamic/private";
import { collections, ready } from "$lib/server/database";
import { probe } from "$lib/server/mcp/discovery";
import { resolveSelection } from "$lib/server/mcp/selection";
import { seal } from "$lib/server/mcp/secretBox";
import type { McpConnector } from "$lib/types/McpConnector";
import { startMockMcp, type MockMcp } from "../../../../../tests/mock-mcp";
import { createTestUser, cleanupTestData, type TestUser } from "./testHelpers";

import { POST } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";

const TOKEN = "right-token";

let mock: MockMcp;
let person: TestUser;
const originalInsecure = env.MCP_ALLOW_INSECURE_URLS;
const originalKey = process.env.CHAT_SECRET_KEY;
const seeded: ObjectId[] = [];

beforeAll(async () => {
	await ready;
	// The mock is on 127.0.0.1, which the SSRF guard lets an MCP transport
	// reach only under this development switch.
	env.MCP_ALLOW_INSECURE_URLS = "true";
	process.env.CHAT_SECRET_KEY ||= "mcp-connector-token-spec";
	mock = await startMockMcp(0, { token: TOKEN });
	person = await createTestUser();
});

afterEach(async () => {
	await collections.mcpConnectors.deleteMany({ _id: { $in: seeded.splice(0) } });
});

afterAll(async () => {
	env.MCP_ALLOW_INSECURE_URLS = originalInsecure;
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
	else process.env.CHAT_SECRET_KEY = originalKey;
	await mock.close();
	await cleanupTestData();
});

async function seed(fields: Partial<McpConnector>): Promise<ObjectId> {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId: person.user._id,
		scope: "user",
		name: "jmcp",
		url: mock.url,
		auth: "none",
		createdAt: new Date(),
		updatedAt: new Date(),
		...fields,
	});
	seeded.push(_id);
	return _id;
}

async function act(id: ObjectId, body: Record<string, unknown>) {
	const response = await POST({
		locals: person.locals,
		params: { id: id.toString() },
		request: new Request("http://localhost/api", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	} as never);
	return (await response.json()) as {
		auth: string;
		lastError?: string;
		tools?: { name: string }[];
	};
}

const toolNames = (view: { tools?: { name: string }[] }) => (view.tools ?? []).map((t) => t.name);

describe("a token-guarded MCP server", () => {
	it("is seen by the anonymous probe as wanting a credential, and the reason says to add one", async () => {
		const result = await probe(mock.url);
		expect(result.auth).toBe("unknown");
		if (result.auth !== "unknown") return;
		expect(result.reason).toContain("no resource metadata");
		expect(result.reason).toMatch(/add it/);
	});

	it("really does refuse a call without the token, so the checks below mean something", async () => {
		const bare = await fetch(mock.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: "{}",
		});
		expect(bare.status).toBe(401);
		expect(bare.headers.get("www-authenticate")).toBeNull();
	});
});

describe("Re-check on a token connector", () => {
	it("lists the tools with the stored token instead of probing anonymously", async () => {
		const id = await seed({
			auth: "token",
			tokenSealed: seal(TOKEN),
			// What the old anonymous Re-check left behind.
			lastError: "it asks for authentication but publishes no resource metadata at …",
		});

		const view = await act(id, { action: "reprobe" });

		expect(view.auth).toBe("token");
		expect(view.lastError).toBeUndefined();
		expect(toolNames(view)).toEqual(expect.arrayContaining(["echo", "add"]));
	});

	it("reports the server's refusal when the token is wrong, and lists nothing", async () => {
		const id = await seed({ auth: "token", tokenSealed: seal("wrong-token") });

		const view = await act(id, { action: "reprobe" });

		expect(view.auth).toBe("token");
		expect(view.lastError).toBeTruthy();
		expect(view.lastError).not.toContain("resource metadata");
		expect(toolNames(view)).toEqual([]);
	});

	it("honours a custom header and an empty prefix", async () => {
		// The mock only accepts `Authorization: Bearer …`, so send exactly that
		// through the custom-header path: header named, prefix spelled out.
		const id = await seed({
			auth: "token",
			tokenSealed: seal(`Bearer ${TOKEN}`),
			tokenHeader: "Authorization",
			tokenPrefix: "",
		});

		const view = await act(id, { action: "reprobe" });

		expect(view.lastError).toBeUndefined();
		expect(toolNames(view)).toContain("echo");
	});
});

describe("adding a token to a connector the probe could not work out", () => {
	it("clears the probe's error, and the next Re-check lists the tools", async () => {
		const reason = "it asks for authentication but offers no OAuth sign-in";
		const id = await seed({ auth: "none", lastError: reason, probedAt: new Date() });

		const updated = await act(id, { action: "update", token: TOKEN });
		expect(updated.auth).toBe("token");
		expect(updated.lastError).toBeUndefined();

		const checked = await act(id, { action: "reprobe" });
		expect(checked.lastError).toBeUndefined();
		expect(toolNames(checked)).toEqual(expect.arrayContaining(["echo", "add"]));
	});
});

describe("a chat turn selecting a token connector", () => {
	it("carries the token as the header the server wants", async () => {
		const id = await seed({ auth: "token", tokenSealed: seal(TOKEN) });

		const resolved = await resolveSelection({
			connectorIds: [id.toString()],
			userId: person.user._id,
		});

		expect(resolved.needAuthorization).toEqual([]);
		expect(resolved.servers).toHaveLength(1);
		expect(resolved.servers[0].headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
	});

	it("is left out, and named, when its token is gone", async () => {
		const id = await seed({ auth: "token" });

		const resolved = await resolveSelection({
			connectorIds: [id.toString()],
			userId: person.user._id,
		});

		expect(resolved.servers).toEqual([]);
		expect(resolved.needAuthorization).toEqual(["jmcp"]);
	});
});
