/**
 * Admin: how the deployment offers its connectors (ADR 0104).
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const gate = vi.hoisted(() => ({ admin: true }));
vi.mock("$lib/server/admin", () => ({
	requireAdmin: vi.fn(async () => {
		if (!gate.admin) throw Object.assign(new Error("no"), { status: 403 });
		return { email: "admin@example.org", isAdmin: true };
	}),
}));
vi.mock("$lib/server/mcp/registry", () => ({
	getMcpServers: () => [{ name: "search", url: "https://search.test/mcp" }],
}));

import { collections, ready } from "$lib/server/database";
import { baseKey, connectorKey, loadPolicies, policyIn } from "$lib/server/mcp/deploymentModes";
import { PUT } from "./+server";

const put = (body: unknown) =>
	PUT({
		locals: {},
		request: new Request("http://localhost/api/v2/admin/connector-modes", {
			method: "PUT",
			body: JSON.stringify(body),
		}),
	} as never).then(
		async (res) => ({ status: res.status, body: await res.json() }),
		(err: { status?: number }) => ({ status: err.status ?? 500, body: null })
	);

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	gate.admin = true;
	await collections.connectorModes.deleteMany({});
	await collections.mcpConnectors.deleteMany({ name: "Modes test" });
});

describe("PUT /api/v2/admin/connector-modes", () => {
	it("sets a .env server's mode and its always-loaded flag, and a default stores nothing", async () => {
		expect((await put({ kind: "base", name: "search", mode: "locked" })).status).toBe(200);
		expect((await put({ kind: "base", name: "search", alwaysLoaded: true })).status).toBe(200);
		expect(policyIn(await loadPolicies(), baseKey("search"))).toEqual({
			mode: "locked",
			alwaysLoaded: true,
		});
		await put({ kind: "base", name: "search", mode: "on", alwaysLoaded: false });
		expect(await collections.connectorModes.countDocuments({ key: baseKey("search") })).toBe(0);
	});

	it("sets an administrator's connector, and refuses somebody else's", async () => {
		const id = new ObjectId();
		const own = new ObjectId();
		await collections.mcpConnectors.insertMany([
			{
				_id: id,
				userId: own,
				scope: "deployment",
				name: "Modes test",
				url: "https://m.test/mcp",
				auth: "none",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
			{
				_id: new ObjectId(),
				userId: own,
				scope: "user",
				name: "Modes test",
				url: "https://p.test/mcp",
				auth: "none",
				createdAt: new Date(),
				updatedAt: new Date(),
			},
		] as never);
		expect((await put({ kind: "connector", id: id.toString(), mode: "off" })).status).toBe(200);
		expect(policyIn(await loadPolicies(), connectorKey(id.toString())).mode).toBe("off");
		const personal = await collections.mcpConnectors.findOne({ scope: "user", name: "Modes test" });
		expect((await put({ kind: "connector", id: String(personal?._id), mode: "off" })).status).toBe(
			404
		);
	});

	it("is for administrators only", async () => {
		gate.admin = false;
		expect((await put({ kind: "base", name: "search", mode: "off" })).status).toBe(403);
		expect(await collections.connectorModes.countDocuments({})).toBe(0);
	});

	it("rejects a mode that does not exist", async () => {
		expect((await put({ kind: "base", name: "search", mode: "optional" })).status).toBe(400);
		expect((await put({ kind: "base", name: "nothing", mode: "off" })).status).toBe(404);
	});
});
