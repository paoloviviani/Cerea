/**
 * A person's connector switch (ADR 0104): the Workspace toggle, and what the
 * deployment's modes allow it to do.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const env = vi.hoisted(() => ({ servers: [{ name: "search", url: "https://search.test/mcp" }] }));
vi.mock("$lib/server/mcp/registry", () => ({ getMcpServers: () => env.servers }));
// The servers on this person's own machines.
vi.mock("$lib/server/mcp/local", () => ({
	localConnectorViews: async () => [{ key: "local:mine:notes" }],
}));

import { collections, ready } from "$lib/server/database";
import { baseKey, loadSwitches, MAX_SWITCHES, setPolicy } from "$lib/server/mcp/deploymentModes";
import { PUT } from "./+server";

const userId = new ObjectId();

const call = (body: unknown, signedIn = true) =>
	Promise.resolve(
		PUT({
			locals: signedIn ? { user: { _id: userId } } : {},
			request: new Request("http://localhost/api/v2/mcp/switches", {
				method: "PUT",
				body: JSON.stringify(body),
			}),
		} as never)
	).then(
		async (res) => ({ status: res.status, body: await res.json() }),
		(err: { status?: number }) => ({ status: err.status ?? 500, body: null })
	);

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.connectorModes.deleteMany({});
	await collections.connectorSwitches.deleteMany({ userId });
});

describe("PUT /api/v2/mcp/switches", () => {
	it("switches a connector off and on again", async () => {
		expect((await call({ key: "base:search", enabled: false })).status).toBe(200);
		expect((await loadSwitches(userId)).off.has("base:search")).toBe(true);
		expect((await call({ key: "base:search", enabled: true })).status).toBe(200);
		expect((await loadSwitches(userId)).off.size).toBe(0);
	});

	it("refuses to switch off a connector the deployment locked, and says it stays on", async () => {
		await setPolicy(baseKey("search"), { mode: "locked" });
		const refused = await call({ key: "base:search", enabled: false });
		expect(refused.status).toBe(409);
		expect((await loadSwitches(userId)).off.size).toBe(0);
		// Switching it on is harmless and answers that it is on.
		expect((await call({ key: "base:search", enabled: true })).body).toMatchObject({
			enabled: true,
		});
	});

	it("does not know a connector the deployment switched off, or one that does not exist", async () => {
		await setPolicy(baseKey("search"), { mode: "off" });
		expect((await call({ key: "base:search", enabled: true })).status).toBe(404);
		expect((await call({ key: "base:nothing", enabled: true })).status).toBe(404);
		expect((await call({ key: "connector:not-an-id", enabled: true })).status).toBe(404);
		expect((await call({ key: "x", enabled: true })).status).toBe(404);
	});

	it("switches a server on the person's own machine, and no one else's (review L3)", async () => {
		expect((await call({ key: "local:mine:notes", enabled: true })).status).toBe(200);
		expect((await loadSwitches(userId)).on.has("local:mine:notes")).toBe(true);
		expect((await call({ key: "local:theirs:mail", enabled: true })).status).toBe(404);
		expect((await loadSwitches(userId)).on.has("local:theirs:mail")).toBe(false);
	});

	it("refuses a new switch past the cap, and still changes one already kept (review L3)", async () => {
		const full = Array.from({ length: MAX_SWITCHES }, (_, i) => `base:s${i}`);
		await collections.connectorSwitches.insertOne({
			_id: new ObjectId(),
			userId,
			off: full,
			on: [],
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		expect((await call({ key: "base:search", enabled: false })).status).toBe(400);
		expect((await loadSwitches(userId)).off.has("base:search")).toBe(false);
	});

	it("needs a signed-in person", async () => {
		expect((await call({ key: "base:search", enabled: false }, false)).status).toBe(401);
	});
});
