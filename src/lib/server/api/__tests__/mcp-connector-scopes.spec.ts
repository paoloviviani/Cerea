/** The Scopes field: validated on add and update; changing it signs everybody out. */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import { seal } from "$lib/server/mcp/secretBox";
import { createTestUser, cleanupTestData } from "./testHelpers";

import { POST as postOne } from "../../../../routes/api/v2/mcp/connectors/[id]/+server";
import { POST as create } from "../../../../routes/api/v2/mcp/connectors/+server";

vi.mock("$lib/server/mcp/discovery", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/mcp/discovery")>();
	return {
		...actual,
		probe: async () => ({
			auth: "oauth",
			oauth: {
				issuer: "https://accounts.google.com/",
				authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
				tokenEndpoint: "https://oauth2.googleapis.com/token",
				scopesSupported: ["https://mail.google.com/"],
				resource: "https://gmailmcp.googleapis.com/mcp/v1",
				supportsS256: true,
			},
		}),
	};
});

const originalKey = process.env.CHAT_SECRET_KEY;
beforeAll(async () => {
	await ready;
	process.env.CHAT_SECRET_KEY ||= "mcp-connector-scopes-spec";
});
afterEach(async () => {
	await collections.mcpTokens.deleteMany({});
	await collections.mcpConnectors.deleteMany({ url: "https://gmailmcp.googleapis.com/mcp/v1" });
	await cleanupTestData();
});
afterAll(() => {
	if (originalKey === undefined) delete process.env.CHAT_SECRET_KEY;
});

const req = (body: unknown) =>
	new Request("http://localhost/api", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

async function add(locals: App.Locals, extra: Record<string, unknown>) {
	return create({
		locals,
		request: req({
			name: "Gmail",
			url: "https://gmailmcp.googleapis.com/mcp/v1",
			authMode: "oauth_static",
			clientId: "cid",
			clientSecret: "sec",
			...extra,
		}),
	} as never);
}

const update = (id: string, locals: App.Locals, body: Record<string, unknown>) =>
	postOne({
		locals,
		params: { id },
		url: new URL(`http://localhost/api/v2/mcp/connectors/${id}`),
		request: req({ action: "update", ...body }),
	} as never);

describe.sequential("connector scopes", () => {
	it("stores scopes as distinct tokens and shows them in the view", async () => {
		const u = await createTestUser();
		const res = await add(u.locals, { scopes: "a b\nc a" });
		const view = (await res.json()) as { id: string; scopes?: string[] };
		expect(view.scopes).toEqual(["a", "b", "c"]);
		const row = await collections.mcpConnectors.findOne({ _id: new ObjectId(view.id) });
		expect(row?.scopes).toEqual(["a", "b", "c"]);
	});

	it("stores none when the field is empty", async () => {
		const u = await createTestUser();
		const view = (await (await add(u.locals, { scopes: "  " })).json()) as { scopes?: string[] };
		expect(view.scopes).toBeUndefined();
	});

	it("refuses an invalid scope", async () => {
		const u = await createTestUser();
		await expect(add(u.locals, { scopes: 'bad"one' })).rejects.toMatchObject({ status: 400 });
		await expect(add(u.locals, { scopes: "x".repeat(600) })).rejects.toMatchObject({ status: 400 });
	});

	it("signs everybody out when the scopes change, and not when they do not", async () => {
		const u = await createTestUser();
		const view = (await (await add(u.locals, { scopes: "a b" })).json()) as { id: string };
		const connectorId = new ObjectId(view.id);
		await collections.mcpTokens.insertOne({
			_id: new ObjectId(),
			connectorId,
			userId: u.user._id,
			accessTokenSealed: seal("t"),
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);

		await update(view.id, u.locals, { scopes: "b a".split(" ").reverse().join(" ") });
		expect(await collections.mcpTokens.countDocuments({ connectorId })).toBe(1);

		await update(view.id, u.locals, { scopes: "a" });
		expect(await collections.mcpTokens.countDocuments({ connectorId })).toBe(0);
		expect((await collections.mcpConnectors.findOne({ _id: connectorId }))?.scopes).toEqual(["a"]);

		await update(view.id, u.locals, { scopes: "" });
		expect((await collections.mcpConnectors.findOne({ _id: connectorId }))?.scopes).toBeUndefined();
	});
});
