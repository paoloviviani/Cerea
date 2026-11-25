import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({ mode: "all" as "off" | "deployment" | "all" }));
vi.mock("./appsMode", () => ({ appsMode: () => state.mode }));
vi.mock("./registry", () => ({
	getMcpServers: () => [{ name: "search", url: "https://search.test/mcp" }],
}));

import { collections, ready } from "$lib/server/database";
import { baseKey, connectorKey, setPolicy } from "./deploymentModes";
import { appsAllowedFor } from "./appsPolicy";
import { parseAppsMode } from "./appsMode.parse";

const me = new ObjectId();
const other = new ObjectId();

const row = (scope: "user" | "deployment", userId = me, extra: Record<string, unknown> = {}) => ({
	_id: new ObjectId(),
	userId,
	scope,
	name: "Apps policy test",
	url: "https://a.test/mcp",
	auth: "none" as const,
	createdAt: new Date(),
	updatedAt: new Date(),
	...extra,
});
const deviceFor = (userId: ObjectId) => ({
	_id: new ObjectId(),
	userId,
	machineId: "m",
	name: "box",
	status: "paired",
	createdAt: new Date(),
});

beforeAll(async () => {
	await ready;
});
afterEach(async () => {
	state.mode = "all";
	await collections.connectorModes.deleteMany({});
	await collections.mcpConnectors.deleteMany({ name: "Apps policy test" });
	await collections.codeDevices.deleteMany({ name: "box" });
});

describe("appsAllowedFor", () => {
	it("allows what the user may use, by default, of every kind", async () => {
		const mine = row("user");
		const shared = row("deployment", other);
		const dev = deviceFor(me);
		await collections.mcpConnectors.insertMany([mine, shared]);
		await collections.codeDevices.insertOne(dev as never);
		expect(await appsAllowedFor(connectorKey(mine._id.toString()), me)).toBe(true);
		expect(await appsAllowedFor(connectorKey(shared._id.toString()), me)).toBe(true);
		expect(await appsAllowedFor(baseKey("search"), me)).toBe(true);
		expect(await appsAllowedFor(`local:${dev._id}:fs`, me)).toBe(true);
	});

	it("refuses another user's connector and another user's device", async () => {
		const theirs = row("user", other);
		const dev = deviceFor(other);
		await collections.mcpConnectors.insertOne(theirs);
		await collections.codeDevices.insertOne(dev as never);
		expect(await appsAllowedFor(connectorKey(theirs._id.toString()), me)).toBe(false);
		expect(await appsAllowedFor(`local:${dev._id}:fs`, me)).toBe(false);
		expect(await appsAllowedFor(`local:${dev._id}:fs`, other)).toBe(true);
	});

	it("follows the administrator's switch on a deployment connector and a .env server", async () => {
		const shared = row("deployment", other);
		await collections.mcpConnectors.insertOne(shared);
		await setPolicy(connectorKey(shared._id.toString()), { appsAllowed: false });
		await setPolicy(baseKey("search"), { appsAllowed: false });
		expect(await appsAllowedFor(connectorKey(shared._id.toString()), me)).toBe(false);
		expect(await appsAllowedFor(baseKey("search"), me)).toBe(false);
	});

	it("reads a malformed policy row with appsAllowed false as false", async () => {
		await collections.connectorModes.insertOne({
			_id: new ObjectId(),
			key: baseKey("search"),
			mode: "bogus",
			appsAllowed: false,
			createdAt: new Date(),
			updatedAt: new Date(),
		} as never);
		expect(await appsAllowedFor(baseKey("search"), me)).toBe(false);
	});

	it("follows the user's own setting on their connector", async () => {
		const off = row("user", me, { appsAllowed: false });
		await collections.mcpConnectors.insertOne(off);
		expect(await appsAllowedFor(connectorKey(off._id.toString()), me)).toBe(false);
	});

	it("refuses a .env server no longer configured, and what it cannot find or understand", async () => {
		expect(await appsAllowedFor(baseKey("gone"), me)).toBe(false);
		expect(await appsAllowedFor(connectorKey(new ObjectId().toString()), me)).toBe(false);
		expect(await appsAllowedFor("connector:not-an-id", me)).toBe(false);
		expect(await appsAllowedFor("local:nope:fs", me)).toBe(false);
		expect(await appsAllowedFor("whatever", me)).toBe(false);
	});

	it("honours the deployment-wide setting first", async () => {
		const mine = row("user");
		const shared = row("deployment", other);
		const dev = deviceFor(me);
		await collections.mcpConnectors.insertMany([mine, shared]);
		await collections.codeDevices.insertOne(dev as never);
		state.mode = "deployment";
		expect(await appsAllowedFor(connectorKey(shared._id.toString()), me)).toBe(true);
		expect(await appsAllowedFor(baseKey("search"), me)).toBe(true);
		expect(await appsAllowedFor(connectorKey(mine._id.toString()), me)).toBe(false);
		expect(await appsAllowedFor(`local:${dev._id}:fs`, me)).toBe(false);
		state.mode = "off";
		expect(await appsAllowedFor(connectorKey(shared._id.toString()), me)).toBe(false);
		expect(await appsAllowedFor(baseKey("search"), me)).toBe(false);
	});
});

describe("setPolicy writes only what changed", () => {
	it("keeps another field set by a concurrent change, and drops a row back at the defaults", async () => {
		const key = baseKey("search");
		await Promise.all([
			setPolicy(key, { appsAllowed: false }),
			setPolicy(key, { alwaysLoaded: true }),
			setPolicy(key, { mode: "locked" }),
		]);
		const stored = await collections.connectorModes.findOne({ key });
		expect(stored).toMatchObject({ appsAllowed: false, alwaysLoaded: true, mode: "locked" });
		await setPolicy(key, { appsAllowed: true, alwaysLoaded: false, mode: "on" });
		expect(await collections.connectorModes.countDocuments({ key })).toBe(0);
	});
});

describe("parseAppsMode", () => {
	it("defaults to all, and fails closed on a word it does not know", () => {
		expect(parseAppsMode("")).toBe("all");
		expect(parseAppsMode(undefined)).toBe("all");
		expect(parseAppsMode(" Deployment ")).toBe("deployment");
		expect(parseAppsMode("off")).toBe("off");
		expect(parseAppsMode("yes")).toBe("off");
	});
});
