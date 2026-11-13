/**
 * `/api/v2/code/memory`: the code panel's view of an agent's notes. Owner only, keyed by
 * computer + scope + key, and only the two agent scopes.
 */
import { ObjectId } from "mongodb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { rememberAgentNote } from "$lib/server/memory/service";
import { GET, POST } from "./+server";
import { DELETE, PATCH } from "./[id]/+server";

vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeAgentsEnabled: () => true,
	codeAgentsAllowedFor: async () => true,
}));

beforeAll(async () => {
	await ready;
}, 30000);

type Person = Awaited<ReturnType<typeof createTestUser>>;
let owner: Person;
let other: Person;
let deviceId: string;

beforeEach(async () => {
	owner = await createTestUser();
	other = await createTestUser();
	const _id = new ObjectId();
	deviceId = _id.toString();
	await collections.codeDevices.insertOne({
		_id,
		userId: owner.user._id,
		machineId: `m-${_id}`,
		status: "paired",
		name: "studio",
	} as never);
});

afterEach(async () => {
	await collections.codeDevices.deleteMany({});
	await collections.agentMemories.deleteMany({});
	await cleanupTestData();
});

const list = (locals: App.Locals, scope = "session", key = "s1", device = deviceId) =>
	testRequest(GET, {
		path: `/api/v2/code/memory?device=${device}&scope=${scope}&key=${key}`,
		locals,
	});
const post = (locals: App.Locals, body: unknown) =>
	testRequest(POST, {
		path: "/api/v2/code/memory",
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
		locals,
	});
const keyOf = (scope: "session" | "workspace" = "session", key = "s1") => ({
	userId: owner.user._id,
	deviceId,
	scope,
	key,
});

describe("/api/v2/code/memory", () => {
	it("lists, adds, edits and deletes the owner's notes for a session", async () => {
		await rememberAgentNote(keyOf(), { text: "Agent wrote this.", source: "model" });
		const first = (await (await list(owner.locals)).json()).data.notes;
		expect(first.map((n: { text: string }) => n.text)).toEqual(["Agent wrote this."]);

		const created = await post(owner.locals, {
			deviceId,
			scope: "session",
			key: "s1",
			text: "Owner typed this.",
		});
		expect(created.status).toBe(201);
		const note = (await created.json()).data;
		expect(note.source).toBe("user");

		const patched = await testRequest(PATCH, {
			path: `/api/v2/code/memory/${note.id}`,
			method: "PATCH",
			params: { id: note.id },
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ deviceId, scope: "session", key: "s1", text: "Owner edited this." }),
			locals: owner.locals,
		});
		expect(patched.status).toBe(200);
		expect((await patched.json()).data.text).toBe("Owner edited this.");

		const removed = await testRequest(DELETE, {
			path: `/api/v2/code/memory/${note.id}?device=${deviceId}&scope=session&key=s1`,
			method: "DELETE",
			params: { id: note.id },
			locals: owner.locals,
		});
		expect(removed.status).toBe(204);
		expect((await (await list(owner.locals)).json()).data.notes).toHaveLength(1);
	});

	it("keeps session and workspace lists apart", async () => {
		await rememberAgentNote(keyOf("session", "s1"), { text: "S.", source: "model" });
		await rememberAgentNote(keyOf("workspace", "w1"), { text: "W.", source: "model" });
		const s = (await (await list(owner.locals, "session", "s1")).json()).data.notes;
		const w = (await (await list(owner.locals, "workspace", "w1")).json()).data.notes;
		expect(s.map((n: { text: string }) => n.text)).toEqual(["S."]);
		expect(w.map((n: { text: string }) => n.text)).toEqual(["W."]);
		expect((await (await list(owner.locals, "session", "w1")).json()).data.notes).toEqual([]);
	});

	it("is owner only: another user gets a 404 for the device and cannot touch the notes", async () => {
		const { memory } = await rememberAgentNote(keyOf(), { text: "Mine.", source: "model" });
		expect((await list(other.locals)).status).toBe(404);
		expect(
			(await post(other.locals, { deviceId, scope: "session", key: "s1", text: "Intruder." }))
				.status
		).toBe(404);
		const del = await testRequest(DELETE, {
			path: `/api/v2/code/memory/${memory._id}?device=${deviceId}&scope=session&key=s1`,
			method: "DELETE",
			params: { id: memory._id.toString() },
			locals: other.locals,
		});
		expect(del.status).toBe(404);
		expect(await collections.agentMemories.countDocuments({})).toBe(1);
	});

	it("only knows the two agent scopes", async () => {
		for (const scope of ["global", "project", "conversation"]) {
			expect((await list(owner.locals, scope)).status).toBe(400);
			expect((await post(owner.locals, { deviceId, scope, key: "s1", text: "x" })).status).toBe(
				400
			);
		}
		expect(await collections.agentMemories.countDocuments({})).toBe(0);
	});
});
