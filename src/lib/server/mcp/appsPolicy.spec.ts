import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

vi.mock("./registry", () => ({
	getMcpServers: () => [{ name: "search", url: "https://search.test/mcp" }],
}));

import { collections, ready } from "$lib/server/database";
import { baseKey, connectorKey, setPolicy } from "./deploymentModes";
import { appsAllowedFor } from "./appsPolicy";

const row = (scope: "user" | "deployment", extra: Record<string, unknown> = {}) => ({
	_id: new ObjectId(),
	userId: new ObjectId(),
	scope,
	name: "Apps policy test",
	url: "https://a.test/mcp",
	auth: "none" as const,
	createdAt: new Date(),
	updatedAt: new Date(),
	...extra,
});

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	await collections.connectorModes.deleteMany({});
	await collections.mcpConnectors.deleteMany({ name: "Apps policy test" });
});

describe("appsAllowedFor", () => {
	it("allows a connector by default, of every kind", async () => {
		const user = row("user");
		const shared = row("deployment");
		await collections.mcpConnectors.insertMany([user, shared]);
		expect(await appsAllowedFor(connectorKey(user._id.toString()))).toBe(true);
		expect(await appsAllowedFor(connectorKey(shared._id.toString()))).toBe(true);
		expect(await appsAllowedFor(baseKey("search"))).toBe(true);
		expect(await appsAllowedFor("local:dev1:fs")).toBe(true);
	});

	it("follows the administrator's switch on a deployment connector and a .env server", async () => {
		const shared = row("deployment");
		await collections.mcpConnectors.insertOne(shared);
		await setPolicy(connectorKey(shared._id.toString()), { appsAllowed: false });
		await setPolicy(baseKey("search"), { appsAllowed: false });
		expect(await appsAllowedFor(connectorKey(shared._id.toString()))).toBe(false);
		expect(await appsAllowedFor(baseKey("search"))).toBe(false);
	});

	it("follows the person's own setting on their connector", async () => {
		const off = row("user", { appsAllowed: false });
		await collections.mcpConnectors.insertOne(off);
		expect(await appsAllowedFor(connectorKey(off._id.toString()))).toBe(false);
	});

	it("allows nothing it cannot find or understand", async () => {
		expect(await appsAllowedFor(connectorKey(new ObjectId().toString()))).toBe(false);
		expect(await appsAllowedFor("connector:not-an-id")).toBe(false);
		expect(await appsAllowedFor("whatever")).toBe(false);
	});
});
