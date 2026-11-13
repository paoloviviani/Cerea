/** The browser endpoints: who may open a browser where, the lease, the deny list, the default. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";

const state = vi.hoisted(() => ({
	enabled: true,
	ready: [] as Array<{ id: string; name: string }>,
	rules: { allow: [] as string[], deny: [] as string[] },
	runtimeOpen: vi.fn(),
	held: new Set<string>(),
}));
vi.mock("$lib/server/browser/settings", async (orig) => ({
	...(await orig<typeof import("$lib/server/browser/settings")>()),
	browserEnabled: () => state.enabled,
	browserSettings: () => ({
		enabled: state.enabled,
		model: "",
		budgets: { maxSteps: 1, maxTokens: 1, maxSeconds: 1 },
		rules: state.rules,
	}),
}));
vi.mock("$lib/server/browser/availability", () => ({ browseMachinesFor: async () => state.ready }));
vi.mock("$lib/server/browser/runtimeClient", async (orig) => {
	const real = await orig<typeof import("$lib/server/browser/runtimeClient")>();
	class FakeRuntime {
		open = state.runtimeOpen;
	}
	return { ...real, McpBrowserRuntime: FakeRuntime };
});
vi.mock("$lib/server/browser/lease", () => ({
	mongoLeaseStore: {
		async acquire(deviceId: string) {
			if (state.held.has(deviceId)) return null;
			return { release: async () => undefined, check: async () => true };
		},
	},
}));

import { collections, ready } from "$lib/server/database";
import { POST as open } from "./open/+server";
import { PUT as setDefault } from "./default/+server";
import { GET as computers } from "./computers/+server";

await ready;

const owner = new ObjectId();
const stranger = new ObjectId();

async function device(userId: ObjectId, name: string, status: "paired" | "revoked" = "paired") {
	const _id = new ObjectId();
	await collections.codeDevices.insertOne({
		_id,
		userId,
		name,
		status,
		machineId: _id.toString(),
		sub: "s",
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id.toString();
}
async function conversation(userId: ObjectId) {
	const _id = new ObjectId();
	await collections.conversations.insertOne({
		_id,
		userId,
		title: "t",
		messages: [],
		model: "m",
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
	return _id.toString();
}

const locals = (user: ObjectId | null) =>
	(user ? { user: { _id: user }, sessionId: "s" } : { sessionId: "s" }) as never;
const post = async (user: ObjectId | null, body: unknown) =>
	open({
		locals: locals(user),
		request: new Request("http://x", { method: "POST", body: JSON.stringify(body) }),
	} as never);
const status = async (p: Promise<Response>) => {
	try {
		return (await p).status;
	} catch (e) {
		return (e as { status: number }).status;
	}
};

beforeEach(async () => {
	state.enabled = true;
	state.ready = [];
	state.rules = { allow: [], deny: [] };
	state.held.clear();
	state.runtimeOpen.mockReset();
	state.runtimeOpen.mockResolvedValue({
		token: "tok",
		id: "t1",
		title: "Home",
		url: "https://a.example.com/",
	});
	await collections.codeDevices.deleteMany({});
});

describe("POST /api/v2/browser/open", () => {
	it("needs a signed-in user, and is absent when browser use is off", async () => {
		const id = await device(owner, "Laptop");
		expect(await status(post(null, { deviceId: id }))).toBe(401);
		state.enabled = false;
		expect(await status(post(owner, { deviceId: id }))).toBe(404);
	});

	it("is 404 for another user's computer or a revoked one, and 400 for a bad body", async () => {
		const theirs = await device(stranger, "Theirs");
		const gone = await device(owner, "Gone", "revoked");
		state.ready = [{ id: theirs, name: "Theirs" }];
		expect(await status(post(owner, { deviceId: theirs }))).toBe(404);
		expect(await status(post(owner, { deviceId: gone }))).toBe(404);
		expect(await status(post(owner, { nope: 1 }))).toBe(400);
		expect(state.runtimeOpen).not.toHaveBeenCalled();
	});

	it("says '<computer> is offline' (409) when its browser is not ready", async () => {
		const id = await device(owner, "Laptop");
		const response = await post(owner, { deviceId: id }).catch((e) => e);
		expect(response.status).toBe(409);
		expect(JSON.stringify(response.body)).toContain("Laptop is offline");
	});

	it("is 404 for a conversation that is not the caller's", async () => {
		const id = await device(owner, "Laptop");
		state.ready = [{ id, name: "Laptop" }];
		const theirs = await conversation(stranger);
		expect(await status(post(owner, { deviceId: id, conversationId: theirs }))).toBe(404);
		expect(await status(post(owner, { deviceId: id, conversationId: "nope" }))).toBe(404);
	});

	it("refuses an address that is not http(s) (400) and a denied site (403)", async () => {
		const id = await device(owner, "Laptop");
		state.ready = [{ id, name: "Laptop" }];
		expect(await status(post(owner, { deviceId: id, url: "file:///etc/passwd" }))).toBe(400);
		state.rules = { allow: [], deny: ["bank.example.org"] };
		const denied = await post(owner, { deviceId: id, url: "https://bank.example.org/" });
		expect(denied.status).toBe(403);
		expect((await denied.json()).error).toBe("denied");
		expect(state.runtimeOpen).not.toHaveBeenCalled();
	});

	it("says busy (409) while a browse task holds the machine", async () => {
		const id = await device(owner, "Laptop");
		state.ready = [{ id, name: "Laptop" }];
		state.held.add(id);
		const response = await post(owner, { deviceId: id, url: "https://a.example.com/" });
		expect(response.status).toBe(409);
		const body = await response.json();
		expect(body.error).toBe("busy");
		expect(body.message).toContain("busy");
		expect(state.runtimeOpen).not.toHaveBeenCalled();
	});

	it("opens a page tied to the conversation: kept token and the chat's computer", async () => {
		const id = await device(owner, "Laptop");
		state.ready = [{ id, name: "Laptop" }];
		const conv = await conversation(owner);
		const response = await post(owner, {
			deviceId: id,
			url: "a.example.com",
			conversationId: conv,
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ opened: true, computer: "Laptop", tied: true });
		expect(state.runtimeOpen).toHaveBeenCalledWith({ url: "https://a.example.com/", deny: [] });
		const device_ = await collections.codeDevices.findOne({ _id: new ObjectId(id) });
		expect(device_?.browserKept?.[conv]?.token).toBe("tok");
		const stored = await collections.conversations.findOne({ _id: new ObjectId(conv) });
		expect(stored?.browserDeviceId).toBe(id);
	});

	it("moving a chat to a computer forgets its kept page on all the user's other computers", async () => {
		const a = await device(owner, "A");
		const b = await device(owner, "B");
		const c = await device(owner, "C");
		const other = await device(stranger, "Theirs");
		const conv = await conversation(owner);
		const kept = { token: "old", at: new Date() };
		for (const id of [a, b, other]) {
			await collections.codeDevices.updateOne(
				{ _id: new ObjectId(id) },
				{ $set: { [`browserKept.${conv}`]: kept } }
			);
		}
		state.ready = [{ id: c, name: "C" }];
		expect((await post(owner, { deviceId: c, conversationId: conv })).status).toBe(200);
		const keptOn = async (id: string) =>
			(await collections.codeDevices.findOne({ _id: new ObjectId(id) }))?.browserKept?.[conv]
				?.token;
		expect(await keptOn(a)).toBeUndefined();
		expect(await keptOn(b)).toBeUndefined();
		expect(await keptOn(c)).toBe("tok");
		// Somebody else's computer is never touched.
		expect(await keptOn(other)).toBe("old");
	});

	it("without a conversation, ties nothing", async () => {
		const id = await device(owner, "Laptop");
		state.ready = [{ id, name: "Laptop" }];
		const response = await post(owner, { deviceId: id });
		expect(await response.json()).toMatchObject({ opened: true, tied: false });
		expect(
			(await collections.codeDevices.findOne({ _id: new ObjectId(id) }))?.browserKept
		).toBeUndefined();
	});
});

describe("PUT /api/v2/browser/default", () => {
	const put = async (user: ObjectId | null, body: unknown) =>
		setDefault({
			locals: locals(user),
			request: new Request("http://x", { method: "PUT", body: JSON.stringify(body) }),
		} as never);

	it("sets one default per user, clears it, and refuses another user's computer", async () => {
		const a = await device(owner, "Laptop");
		const b = await device(owner, "Desk");
		const c = await device(stranger, "Theirs");
		expect((await put(owner, { deviceId: a })).status).toBe(200);
		expect((await put(owner, { deviceId: b })).status).toBe(200);
		const flags = async () =>
			(await collections.codeDevices.find({ userId: owner, browserDefault: true }).toArray()).map(
				(d) => d.name
			);
		expect(await flags()).toEqual(["Desk"]);
		expect(await status(put(owner, { deviceId: c }))).toBe(404);
		expect(await status(put(null, { deviceId: a }))).toBe(401);
		expect((await put(owner, { deviceId: null })).status).toBe(200);
		expect(await flags()).toEqual([]);
		// The stranger's default is untouched by the owner's changes.
		expect((await put(stranger, { deviceId: c })).status).toBe(200);
		await put(owner, { deviceId: null });
		expect((await collections.codeDevices.findOne({ _id: new ObjectId(c) }))?.browserDefault).toBe(
			true
		);
	});
});

describe("the default computer, when two are flagged (a race)", () => {
	it("is the one set last", async () => {
		const { mongoChoiceStore } = await import("$lib/server/browser/machineChoice");
		const a = await device(owner, "Old");
		const b = await device(owner, "New");
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(a) },
			{ $set: { browserDefault: true, browserDefaultAt: new Date(1000) } }
		);
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(b) },
			{ $set: { browserDefault: true, browserDefaultAt: new Date(2000) } }
		);
		expect(await mongoChoiceStore.defaultDevice(owner)).toBe(b);
	});
});

describe("GET /api/v2/browser/computers", () => {
	it("lists the ready computers, the default first", async () => {
		const a = await device(owner, "Alpha");
		const b = await device(owner, "Beta");
		state.ready = [
			{ id: a, name: "Alpha" },
			{ id: b, name: "Beta" },
		];
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(b) },
			{ $set: { browserDefault: true } }
		);
		const body = await (
			await computers({ locals: locals(owner), url: new URL("http://x/") } as never)
		).json();
		expect(
			body.computers.map((c: { name: string; default: boolean }) => [c.name, c.default])
		).toEqual([
			["Beta", true],
			["Alpha", false],
		]);
	});
	it("is empty when none is ready, and absent when off", async () => {
		const body = await (
			await computers({ locals: locals(owner), url: new URL("http://x/") } as never)
		).json();
		expect(body.computers).toEqual([]);
		state.enabled = false;
		expect(
			await status(
				Promise.resolve(computers({ locals: locals(owner), url: new URL("http://x/") } as never))
			)
		).toBe(404);
	});
});
