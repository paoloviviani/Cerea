/**
 * Which connectors a turn may use, and which of those are loaded (ADR 0104).
 *
 * The inputs are the deployment's policies, the person's switches and the
 * conversation's loaded set, and nothing the browser sends: `mcpLocalsFor` takes
 * no selection at all. Each negative is paired with a positive on the same data.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { ObjectId } from "mongodb";

const env = vi.hoisted(() => ({
	servers: [] as Array<{ name: string; url: string; headers?: Record<string, string> }>,
}));
vi.mock("./registry", () => ({ getMcpServers: () => env.servers }));

import { collections, ready } from "$lib/server/database";
import {
	baseKey,
	connectorKey,
	setPolicy,
	setSwitch,
	loadSwitches,
	isEnabled,
	offeredEnvServers,
} from "./deploymentModes";
import { mcpLocalsFor } from "./selection";
import { resetCatalogCache, rememberTools } from "./catalogCache";

const userId = new ObjectId();
const other = new ObjectId();
const ids = {
	locked: new ObjectId(),
	on: new ObjectId(),
	off: new ObjectId(),
	own: new ObjectId(),
	theirs: new ObjectId(),
};

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	env.servers = [];
	resetCatalogCache();
	await collections.connectorModes.deleteMany({});
	await collections.connectorSwitches.deleteMany({ userId: { $in: [userId, other] } });
	await collections.mcpConnectors.deleteMany({ _id: { $in: Object.values(ids) } });
});

async function seedConnectors() {
	const row = (_id: ObjectId, name: string, scope: "user" | "deployment", owner = userId) => ({
		_id,
		userId: owner,
		scope,
		name,
		url: `https://${name.toLowerCase()}.test/mcp`,
		auth: "none" as const,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	await collections.mcpConnectors.insertMany([
		row(ids.locked, "Locked", "deployment"),
		row(ids.on, "On", "deployment"),
		row(ids.off, "Off", "deployment"),
		row(ids.own, "Own", "user"),
		row(ids.theirs, "Theirs", "user", other),
	]);
	await setPolicy(connectorKey(ids.locked.toString()), { mode: "locked" });
	await setPolicy(connectorKey(ids.off.toString()), { mode: "off" });
}

const names = (list: { name: string }[]) => list.map((c) => c.name).sort();

describe("what is on for a person", () => {
	it("starts with every deployment connector on, and their own", async () => {
		await seedConnectors();
		env.servers = [{ name: "search", url: "https://search.test/mcp" }];
		const locals = await mcpLocalsFor({}, userId);
		// Off is offered to nobody; another person's own connector is not in the list.
		expect(names(locals.connectors)).toEqual(["Locked", "On", "Own", "search"]);
	});

	it("honours a person's switch for On, never for Locked, and never offers Off", async () => {
		await seedConnectors();
		env.servers = [{ name: "search", url: "https://search.test/mcp" }];
		for (const key of [
			connectorKey(ids.locked.toString()),
			connectorKey(ids.on.toString()),
			connectorKey(ids.off.toString()),
			connectorKey(ids.own.toString()),
			baseKey("search"),
		]) {
			await setSwitch(userId, key, false);
		}
		const locals = await mcpLocalsFor({}, userId);
		expect(names(locals.connectors)).toEqual(["Locked"]);
		expect(locals.blocked.map((b) => b.name).sort()).toEqual(["On", "Own", "search"]);
		// Another person's switches change nothing for this one.
		await setSwitch(other, connectorKey(ids.locked.toString()), false);
		expect(names((await mcpLocalsFor({}, userId)).connectors)).toContain("Locked");
	});

	it("never offers a .env server the administrator switched off, nor lists it as something the person turned off", async () => {
		env.servers = [
			{ name: "search", url: "https://search.test/mcp" },
			{ name: "osm", url: "https://osm.test/mcp" },
		];
		await setPolicy(baseKey("osm"), { mode: "off" });
		const locals = await mcpLocalsFor({ loadedConnectors: ["base:osm"] }, userId);
		expect(names(locals.connectors)).toEqual(["search"]);
		expect(locals.blocked).toEqual([]);
		expect(locals.servers).toEqual([]);
	});

	it("turns a switch back to the default by removing it", async () => {
		await setSwitch(userId, "base:search", false);
		expect((await loadSwitches(userId)).off.has("base:search")).toBe(true);
		await setSwitch(userId, "base:search", true);
		expect((await loadSwitches(userId)).off.size).toBe(0);
		expect(isEnabled("base:search", undefined, await loadSwitches(userId))).toBe(true);
	});

	it("keeps servers on their machines off until they are switched on", () => {
		const none = { off: new Set<string>(), on: new Set<string>() };
		expect(isEnabled("local:dev:notes", undefined, none)).toBe(false);
		expect(
			isEnabled("local:dev:notes", undefined, { ...none, on: new Set(["local:dev:notes"]) })
		).toBe(true);
	});
});

describe("what is loaded", () => {
	it("loads an always loaded connector, and what the conversation loaded, in that order", async () => {
		await seedConnectors();
		env.servers = [{ name: "search", url: "https://search.test/mcp" }];
		await setPolicy(baseKey("search"), { alwaysLoaded: true });
		const locals = await mcpLocalsFor(
			{ loadedConnectors: [connectorKey(ids.own.toString()), connectorKey(ids.on.toString())] },
			userId
		);
		expect(locals.loadedKeys).toEqual([
			"base:search",
			connectorKey(ids.own.toString()),
			connectorKey(ids.on.toString()),
		]);
		expect(locals.servers.map((s) => s.name)).toEqual(["search", "Own", "On"]);
	});

	it("does not load what is no longer on, whatever the conversation remembers", async () => {
		await seedConnectors();
		const locals = await mcpLocalsFor(
			{
				loadedConnectors: [
					connectorKey(ids.off.toString()),
					connectorKey(ids.theirs.toString()),
					"base:gone",
					connectorKey(ids.on.toString()),
				],
			},
			userId
		);
		expect(locals.servers.map((s) => s.name)).toEqual(["On"]);
	});

	it("builds a turn without contacting any connector", async () => {
		let requests = 0;
		const fake: Server = createServer((_req, res) => {
			requests += 1;
			res.end("{}");
		});
		await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
		try {
			const { port } = fake.address() as { port: number };
			env.servers = [
				{ name: "maps", url: `http://127.0.0.1:${port}/mcp` },
				{ name: "search", url: `http://127.0.0.1:${port}/other` },
			];
			rememberTools(env.servers[0].url, [{ name: "route", description: "Plan a route." }]);
			await setPolicy(baseKey("search"), { alwaysLoaded: true });
			const locals = await mcpLocalsFor({}, userId);
			expect(requests).toBe(0);
			// The line for the assistant comes from the cache, without a connection.
			const maps = locals.connectors.find((c) => c.name === "maps");
			expect(maps?.toolNames).toEqual(["route"]);
			expect(maps?.summary).toBe("Plan a route.");
		} finally {
			await new Promise((resolve) => fake.close(resolve));
		}
	});
});

describe("the catalogue line of a connector row (review M3)", () => {
	it("uses the tools stored on its own row, never another listing of the same address", async () => {
		await seedConnectors();
		const url = "https://own.test/mcp";
		await collections.mcpConnectors.updateOne(
			{ _id: ids.own },
			{ $set: { tools: [{ name: "own_tool", description: "Mine." }] } }
		);
		// What somebody else's credential listed at the same address.
		rememberTools(url, [{ name: "someone_elses_tool", description: "Not yours." }]);
		const own = (await mcpLocalsFor({}, userId)).connectors.find((c) => c.name === "Own");
		expect(own?.toolNames).toEqual(["own_tool"]);
		expect(own?.summary).toBe("Mine.");
	});
});

describe("what the catalogue refresh polls (review L1)", () => {
	it("is the .env servers the deployment offers, not those set Off", async () => {
		env.servers = [
			{ name: "search", url: "https://search.test/mcp" },
			{ name: "osm", url: "https://osm.test/mcp" },
		];
		await setPolicy(baseKey("osm"), { mode: "off" });
		expect((await offeredEnvServers()).map((s) => s.name)).toEqual(["search"]);
	});
});

describe("failing closed (review L2)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("offers no deployment connector when the policies cannot be read, and keeps the person's own", async () => {
		await seedConnectors();
		env.servers = [{ name: "search", url: "https://search.test/mcp" }];
		vi.spyOn(collections.connectorModes, "find").mockImplementation(() => {
			throw new Error("database unavailable");
		});
		const locals = await mcpLocalsFor({}, userId);
		expect(names(locals.connectors)).toEqual(["Own"]);
	});

	it("keeps only what is locked on when the person's switches cannot be read", async () => {
		await seedConnectors();
		env.servers = [{ name: "search", url: "https://search.test/mcp" }];
		vi.spyOn(collections.connectorSwitches, "findOne").mockRejectedValue(new Error("down"));
		const locals = await mcpLocalsFor({}, userId);
		expect(names(locals.connectors)).toEqual(["Locked"]);
	});
});

describe("recording a switch (review L3)", () => {
	afterEach(() => vi.restoreAllMocks());

	it("is one atomic update, and moves the key between the lists", async () => {
		const spy = vi.spyOn(collections.connectorSwitches, "updateOne");
		await setSwitch(userId, "local:dev:notes", true);
		expect(spy).toHaveBeenCalledTimes(1);
		expect((await loadSwitches(userId)).on.has("local:dev:notes")).toBe(true);
		await setSwitch(userId, "base:search", false);
		await setSwitch(userId, "base:search", true);
		const after = await loadSwitches(userId);
		expect([...after.off]).toEqual([]);
		expect([...after.on]).toEqual(["local:dev:notes"]);
		expect(spy).toHaveBeenCalledTimes(3);
	});
});
