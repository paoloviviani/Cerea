/**
 * `GET | PUT | DELETE /api/v2/projects/[id]/agent-profile` (ADR 0106): each user keeps their own
 * profile for a project they can open, validated like a schedule target against the fake machine
 * the /code specs share.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { ObjectId } from "mongodb";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { cleanupTestData, createTestUser } from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { PATCH as devicesPATCH } from "../../../code/devices/+server";
import { DELETE as deleteProject } from "../+server";
import { FakeMachine } from "../../../../../../../tests/fake-machine";
import { DELETE, GET, PUT } from "./+server";

vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	codeAgentsEnabled: () => true,
	codeAgentsAllowedFor: async () => true,
}));

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
const machines: FakeMachine[] = [];

beforeAll(async () => {
	await ready;
	wss = new WebSocketServer({ noServer: true });
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => acceptMachineConnection(ws, req, principal, "t"));
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	port = typeof address === "object" && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
	wss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

type Person = Awaited<ReturnType<typeof createTestUser>>;

async function pairFor(owner: Person): Promise<FakeMachine> {
	principal = {
		userId: owner.user._id,
		sub: owner.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "build box",
	};
	const m = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, {});
	machines.push(m);
	const { deviceId } = await m.hello();
	const res = await testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${deviceId}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "confirm" }),
		locals: owner.locals,
	});
	expect(res.status).toBe(200);
	await m.waitForPaired();
	m.model.workspaces.push({
		id: "ws1",
		name: "repo",
		path: "/work/repo",
		createdAt: new Date().toISOString(),
		isGitRepo: true,
	});
	return m;
}

let owner: Person;
let member: Person;
let outsider: Person;
let ownerLocals: App.Locals;
let memberLocals: App.Locals;
let outsiderLocals: App.Locals;
let ownerMachine: FakeMachine;
let memberMachine: FakeMachine;
let projectId: ObjectId;

beforeEach(async () => {
	owner = await createTestUser();
	member = await createTestUser();
	outsider = await createTestUser();
	ownerLocals = owner.locals;
	// A share names an address; the viewer's own address is what matches it.
	memberLocals = { ...member.locals, user: { ...member.user, email: "member@example.org" } };
	outsiderLocals = {
		...outsider.locals,
		user: { ...outsider.user, email: "outsider@example.org" },
	};
	ownerMachine = await pairFor(owner);
	memberMachine = await pairFor(member);
	projectId = new ObjectId();
	await collections.projects.insertOne({
		_id: projectId,
		userId: owner.user._id,
		name: "P",
		instructions: "",
		knowledgeBaseIds: [],
		indexPastChats: false,
		retrievalLimit: 6,
		shares: [{ kind: "user", email: "member@example.org" }],
		createdAt: new Date(),
		updatedAt: new Date(),
	} as never);
});

afterEach(async () => {
	for (const m of machines.splice(0)) m.close();
	await collections.projects.deleteMany({});
	await collections.projectAgentProfiles.deleteMany({});
	await cleanupTestData();
});

const path = () => `/api/v2/projects/${projectId}/agent-profile`;
const params = () => ({ id: projectId.toString() });
const put = (locals: App.Locals, body: unknown) =>
	testRequest(PUT, {
		path: path(),
		method: "PUT",
		params: params(),
		locals,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const get = (locals: App.Locals) => testRequest(GET, { path: path(), params: params(), locals });
const del = (locals: App.Locals) =>
	testRequest(DELETE, { path: path(), method: "DELETE", params: params(), locals });

const valid = (m: FakeMachine, over: Record<string, unknown> = {}) => ({
	deviceId: m.deviceId,
	workspaceId: "ws1",
	permissionMode: "allow",
	...over,
});

describe("/api/v2/projects/[id]/agent-profile", () => {
	it("stores the caller's profile with the labels resolved by the server, and reads it back", async () => {
		expect(await (await get(ownerLocals)).json()).toBeNull();
		const res = await put(
			ownerLocals,
			valid(ownerMachine, {
				modeId: "build",
				modelId: "pystino/mock-model",
				// A client cannot name its own labels.
				labels: { device: "forged", workspace: "forged" },
			})
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({
			deviceId: ownerMachine.deviceId,
			workspaceId: "ws1",
			permissionMode: "allow",
			modeId: "build",
			modelId: "pystino/mock-model",
			labels: { device: "build box", workspace: "repo" },
		});
		expect(await (await get(ownerLocals)).json()).toMatchObject({ labels: { workspace: "repo" } });
		// One row per (project, user), replaced on a second PUT.
		await put(ownerLocals, valid(ownerMachine, { permissionMode: "deny" }));
		const rows = await collections.projectAgentProfiles.find({}).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ permissionMode: "deny" });
		expect(rows[0]).not.toHaveProperty("modeId");
	});

	it("stores a connector default (none unless set), and refuses a connector that is not the caller's", async () => {
		const { seal } = await import("$lib/server/mcp/secretBox");
		const row = (userId: ObjectId, name: string) => ({
			_id: new ObjectId(),
			userId,
			scope: "user" as const,
			name,
			url: `https://${name.toLowerCase()}.test/mcp`,
			auth: "token" as const,
			tokenSealed: seal("t"),
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const mine = row(owner.user._id, "Mine");
		const theirs = row(member.user._id, "Theirs");
		await collections.mcpConnectors.insertMany([mine, theirs]);
		try {
			const none = await put(ownerLocals, valid(ownerMachine));
			expect(await none.json()).not.toHaveProperty("connectorKeys");

			const keys = [`connector:${mine._id}`];
			const set = await put(ownerLocals, valid(ownerMachine, { connectorKeys: keys }));
			expect(set.status).toBe(200);
			expect(await set.json()).toMatchObject({ connectorKeys: keys });
			expect(await (await get(ownerLocals)).json()).toMatchObject({ connectorKeys: keys });

			const stolen = await put(
				ownerLocals,
				valid(ownerMachine, { connectorKeys: [`connector:${theirs._id}`] })
			);
			expect(stolen.status).toBe(400);
			// The refused save changed nothing.
			expect(await (await get(ownerLocals)).json()).toMatchObject({ connectorKeys: keys });
		} finally {
			await collections.mcpConnectors.deleteMany({ _id: { $in: [mine._id, theirs._id] } });
		}
	});

	it("keeps each user's profile their own: a shared member sets, reads and deletes only theirs", async () => {
		await put(ownerLocals, valid(ownerMachine));
		expect((await put(memberLocals, valid(memberMachine, { permissionMode: "ask" }))).status).toBe(
			200
		);

		expect(await (await get(memberLocals)).json()).toMatchObject({
			deviceId: memberMachine.deviceId,
			permissionMode: "ask",
		});
		expect(await (await get(ownerLocals)).json()).toMatchObject({
			deviceId: ownerMachine.deviceId,
			permissionMode: "allow",
		});

		expect((await del(memberLocals)).status).toBe(204);
		expect(await (await get(memberLocals)).json()).toBeNull();
		expect(await (await get(ownerLocals)).json()).toMatchObject({ permissionMode: "allow" });
	});

	it("answers 404 on every verb to somebody who cannot open the project, and writes nothing", async () => {
		await put(ownerLocals, valid(ownerMachine));
		const outsiderMachine = await pairFor(outsider);
		const statuses = [
			(await get(outsiderLocals)).status,
			(await put(outsiderLocals, valid(outsiderMachine))).status,
			(await del(outsiderLocals)).status,
		];
		expect(statuses).toEqual([404, 404, 404]);
		expect(await collections.projectAgentProfiles.countDocuments({})).toBe(1);
	});

	it("needs an account", async () => {
		const anonymous = {
			sessionId: "x",
			isAdmin: false,
			user: undefined,
			token: undefined,
		} as App.Locals;
		expect((await get(anonymous)).status).toBe(401);
		expect((await put(anonymous, valid(ownerMachine))).status).toBe(401);
	});

	it("validates like a schedule target", async () => {
		const status = async (body: unknown) => (await put(ownerLocals, body)).status;
		// Another user's machine: as if it did not exist.
		const res = await put(ownerLocals, valid(memberMachine));
		expect(res.status).toBe(400);
		expect(JSON.stringify(await res.json())).toContain("not one of yours");
		expect(await status(valid(ownerMachine, { deviceId: "not-an-id" }))).toBe(400);
		expect(await status(valid(ownerMachine, { workspaceId: "nope" }))).toBe(400);
		expect(await status(valid(ownerMachine, { permissionMode: "yolo" }))).toBe(400);
		expect(await status({ deviceId: ownerMachine.deviceId })).toBe(400);
		expect(await status(valid(ownerMachine, { modelId: "opencode/free" }))).toBe(400);
		expect(await collections.projectAgentProfiles.countDocuments({})).toBe(0);
	});

	it("is erased with the project, every member's included", async () => {
		await put(ownerLocals, valid(ownerMachine));
		await put(memberLocals, valid(memberMachine));
		expect(await collections.projectAgentProfiles.countDocuments({})).toBe(2);
		const res = await testRequest(deleteProject, {
			path: `/api/v2/projects/${projectId}`,
			method: "DELETE",
			params: params(),
			locals: ownerLocals,
		});
		expect(res.status).toBe(204);
		expect(await collections.projectAgentProfiles.countDocuments({})).toBe(0);
	});
});
