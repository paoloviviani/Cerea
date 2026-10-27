/**
 * How the deployment offers its own connectors: on for everyone, optional, off.
 *
 * The browser's stored selection can be weeks stale, so the property under test is
 * that it cannot decide: an always-on connector is in the turn whatever was sent, an
 * off one never is, an optional one only when chosen. Each negative is paired with a
 * positive on the same data.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const env = vi.hoisted(() => ({
	servers: [
		{ name: "search", url: "https://search.test/mcp", headers: { "X-Key": "k" } },
		{ name: "osm", url: "https://osm.test/mcp" },
		{ name: "dict", url: "https://dict.test/mcp" },
	],
}));
vi.mock("./registry", () => ({ getMcpServers: () => env.servers }));

import { collections, ready } from "$lib/server/database";
import {
	envServersFor,
	setMode,
	baseKey,
	connectorKey,
	effectiveConnectorIds,
} from "./deploymentModes";
import { mcpLocalsFor } from "./selection";

const userId = new ObjectId();
const ids = {
	always: new ObjectId(),
	optional: new ObjectId(),
	off: new ObjectId(),
	own: new ObjectId(),
};

beforeAll(async () => {
	await ready;
});

afterEach(async () => {
	await collections.connectorModes.deleteMany({});
	await collections.mcpConnectors.deleteMany({ _id: { $in: Object.values(ids) } });
});

async function seedConnectors() {
	const row = (_id: ObjectId, name: string, scope: "user" | "deployment") => ({
		_id,
		userId,
		scope,
		name,
		url: `https://${name.toLowerCase()}.test/mcp`,
		auth: "none" as const,
		createdAt: new Date(),
		updatedAt: new Date(),
	});
	await collections.mcpConnectors.insertMany([
		row(ids.always, "Always", "deployment"),
		row(ids.optional, "Optional", "deployment"),
		row(ids.off, "Off", "deployment"),
		row(ids.own, "Own", "user"),
	]);
	await setMode(connectorKey(ids.optional.toString()), "optional");
	await setMode(connectorKey(ids.off.toString()), "off");
}

const names = (servers: { name: string }[]) => servers.map((s) => s.name).sort();

describe(".env servers", () => {
	it("are on for everyone by default, whatever the browser sent", async () => {
		expect(names(await envServersFor(undefined))).toEqual(["dict", "osm", "search"]);
		expect(names(await envServersFor([]))).toEqual(["dict", "osm", "search"]);
	});

	it("leave out an off server even when it is named, and an optional one unless it is", async () => {
		await setMode(baseKey("osm"), "off");
		await setMode(baseKey("dict"), "optional");
		expect(names(await envServersFor(["osm", "dict", "search"]))).toEqual(["dict", "search"]);
		expect(names(await envServersFor(["osm"]))).toEqual(["search"]);
		expect(names(await envServersFor(undefined))).toEqual(["search"]);
		// A resume keeps the optional one it was approved under, never the off one.
		expect(names(await envServersFor("any"))).toEqual(["dict", "search"]);
	});

	it("take effect on the next call, with nothing cached", async () => {
		expect(names(await envServersFor(undefined))).toContain("osm");
		await setMode(baseKey("osm"), "off");
		expect(names(await envServersFor(undefined))).not.toContain("osm");
		await setMode(baseKey("osm"), "always");
		expect(names(await envServersFor(undefined))).toContain("osm");
	});
});

describe("a turn's connectors", () => {
	it("add the always-on one, keep optional only when chosen, drop the off one", async () => {
		await seedConnectors();
		const stale = [ids.off.toString(), ids.own.toString()];
		const resolved = await effectiveConnectorIds(stale);
		expect(resolved.ids.sort()).toEqual([ids.always.toString(), ids.own.toString()].sort());

		const chosen = await effectiveConnectorIds([ids.optional.toString()]);
		expect(chosen.ids).toContain(ids.optional.toString());
		expect(chosen.ids).toContain(ids.always.toString());
	});

	it("resolve through mcpLocalsFor, which the route and both sweepers use", async () => {
		await seedConnectors();
		const locals = await mcpLocalsFor(
			{
				connectorIds: [ids.off.toString(), ids.own.toString()],
				serverNames: ["Own"],
				customServers: [
					// a stale tab's copy of an .env server: ignored, so its headers survive and its mode rules
					{ name: "osm", url: "https://stale.test/mcp" },
					{ name: "adhoc", url: "https://adhoc.test/mcp" },
				],
			},
			userId
		);
		expect(names(locals.selectedServers)).toEqual(["Always", "Own", "adhoc"]);
		// The names the pipeline filters by now include the deployment's own connector.
		expect(locals.selectedServerNames).toEqual(expect.arrayContaining(["Always", "Own"]));
		expect(locals.selectedServerNames).not.toContain("Off");
	});

	it("do not nag the model about an always-on connector the person has not signed in to", async () => {
		await seedConnectors();
		await collections.mcpConnectors.updateOne({ _id: ids.always }, { $set: { auth: "oauth" } });
		const locals = await mcpLocalsFor({ connectorIds: [], customServers: [] }, userId);
		expect(locals.selectedServers).toEqual([]);
		expect(locals.unavailable).toEqual([]);
	});
});
