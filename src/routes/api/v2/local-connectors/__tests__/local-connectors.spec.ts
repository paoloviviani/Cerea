/**
 * Local MCP connectors end to end (ADR 0102): a fake connectors machine
 * (`tests/fake-machine.ts`) serving real SDK MCP servers over the `mcp` frames, Cerea's own
 * client pool and tool calls over the machine transport, and the endpoints the Local connectors
 * tab and the MCP panel use. Driven over a real WebSocket through the production
 * `acceptMachineConnection`, like the other machine specs.
 */
import { vi } from "vitest";

const overrides = vi.hoisted(
	() =>
		({
			PUBLIC_ORIGIN: "https://chat.example.org",
			LOCAL_CONNECTORS_ENABLED: "true",
			CODE_AGENTS_ENABLED: "true",
		}) as Record<string, string>
);

vi.mock("$lib/server/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/config")>();
	return {
		...actual,
		get config() {
			return new Proxy(actual.config, {
				get(target, prop, receiver) {
					if (typeof prop === "string" && prop in overrides) return overrides[prop];
					return Reflect.get(target, prop, receiver);
				},
			});
		},
	};
});

import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	cleanupTestData,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection, isMachineOnline } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine, type FakeMcpServer } from "../../../../../../tests/fake-machine";
import { drainPool, getClient } from "$lib/server/mcp/clientPool";
import { callMcpTool } from "$lib/server/mcp/httpClient";
import { localServerUrl } from "$lib/server/mcp/localUrl";
import { mcpLocalsFor } from "$lib/server/mcp/selection";
import { resetLocalListCache } from "$lib/server/mcp/local";
import { createLocalTransport } from "$lib/server/mcp/localTransport";
import { getPairedDevice, listDevices } from "$lib/server/codeDevices";
import { GET as listGET } from "../+server";
import { PATCH as machinePATCH, DELETE as machineDELETE } from "../machines/[id]/+server";
import { POST as oauthStart } from "../oauth/start/+server";
import { GET as oauthCallback } from "../oauth/callback/+server";
import { GET as toolsGET } from "../tools/+server";
import { GET as connectorsGET } from "../../mcp/connectors/+server";

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let principal: MachinePrincipal;
let user: TestUser;

beforeAll(async () => {
	await ready;
	wss = new WebSocketServer({ noServer: true });
	httpServer = createServer();
	httpServer.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			acceptMachineConnection(ws, req, principal, "test-token");
		});
	});
	await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
	const address = httpServer.address();
	port = typeof address === "object" && address ? address.port : 0;
}, 30_000);

afterAll(async () => {
	wss.close();
	await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

function principalFor(owner: TestUser, machineName = "laptop"): MachinePrincipal {
	return {
		userId: owner.user._id,
		sub: owner.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName,
	};
}

beforeEach(async () => {
	overrides.LOCAL_CONNECTORS_ENABLED = "true";
	overrides.CODE_AGENTS_ENABLED = "true";
	user = await createTestUser();
	// A fresh sign-in, which approving a machine asks for (as /code does).
	await collections.sessions.updateOne(
		{ sessionId: user.locals.sessionId },
		{ $set: { authTime: new Date() } }
	);
	principal = principalFor(user);
	resetLocalListCache();
});

let openMachines: FakeMachine[] = [];

afterEach(async () => {
	await drainPool();
	await collections.localConnectorOauth.deleteMany({});
	for (const machine of openMachines) machine.close();
	openMachines = [];
	await cleanupTestData();
});

const notes: FakeMcpServer = {
	name: "notes",
	description: "My notes folder",
	tools: [
		{
			name: "echo",
			description: "Echo the text",
			inputSchema: {
				type: "object",
				properties: { text: { type: "string" } },
				required: ["text"],
			},
			handler: (args) => `echo: ${String(args.text)}`,
		},
		// Never answers: lets a test end the channel under a call in flight.
		{ name: "hang", handler: () => new Promise<string>(() => {}) },
	],
};

function connectorsMachine(servers: FakeMcpServer[] = [notes], authorizationUrl?: string) {
	const machine = new FakeMachine(
		`ws://127.0.0.1:${port}/api/v2/code/machine`,
		{},
		{
			backends: [],
			machine: { mode: "connectors", capabilities: { mcp: true } },
			mcp: { servers, authorizationUrl },
		}
	);
	openMachines.push(machine);
	return machine;
}

async function pair(machine: FakeMachine, owner: TestUser = user): Promise<string> {
	const { deviceId, status } = await machine.hello();
	expect(status).toBe("pending");
	const res = await testRequest(machinePATCH, {
		method: "PATCH",
		path: `/api/v2/local-connectors/machines/${deviceId}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "confirm" }),
		locals: owner.locals,
		params: { id: deviceId },
	});
	expect(res.status).toBe(200);
	await machine.waitForPaired();
	return deviceId;
}

const urlOf = (deviceId: string, server = "notes", owner: TestUser = user) =>
	localServerUrl(owner.user._id.toString(), deviceId, server);

async function offline(machine: FakeMachine, deviceId: string): Promise<void> {
	machine.close();
	for (let i = 0; i < 100 && isMachineOnline(deviceId); i++) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(isMachineOnline(deviceId)).toBe(false);
}

describe("a local server through the machine transport", () => {
	it("initializes, lists tools and calls one, like any connector", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);

		const client = await getClient({ name: "notes", url: urlOf(deviceId) });
		const tools = await client.listTools();
		expect(tools.tools.map((t) => t.name).sort()).toEqual(["echo", "hang"]);

		const result = await callMcpTool({ name: "notes", url: urlOf(deviceId) }, "echo", {
			text: "hello",
		});
		expect(result.text).toBe("echo: hello");
		expect(result.isError).toBe(false);
		expect(machine.mcpToolCalls).toEqual([
			{ server: "notes", tool: "echo", args: { text: "hello" } },
		]);
	});

	it("keeps one channel per (person, device, server) between turns", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		await callMcpTool({ name: "notes", url: urlOf(deviceId) }, "echo", { text: "a" });
		await callMcpTool({ name: "notes", url: urlOf(deviceId) }, "echo", { text: "b" });
		expect(machine.openMcpChannels()).toHaveLength(1);
		await drainPool();
		// Closing the pool closes the channel on the machine (mcp.close).
		await vi.waitFor(() => expect(machine.openMcpChannels()).toHaveLength(0));
		expect(machine.opLog.filter((o) => o.op === "mcp.close")).toHaveLength(1);
	});

	it("fails a call at once when the machine closes the channel under it, and reopens next time", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);

		const started = Date.now();
		const call = callMcpTool(
			{ name: "notes", url: urlOf(deviceId) },
			"hang",
			{},
			{ timeoutMs: 30_000 }
		);
		await vi.waitFor(() => expect(machine.mcpToolCalls).toHaveLength(1));
		machine.closeMcpChannel(machine.openMcpChannels()[0], "crashed", "exit status 1");
		await expect(call).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(5_000);
		// Not run a second time on a fresh channel: the server may have done part of it.
		expect(machine.mcpToolCalls).toHaveLength(1);

		const again = await callMcpTool({ name: "notes", url: urlOf(deviceId) }, "echo", {
			text: "back",
		});
		expect(again.text).toBe("echo: back");
		expect(machine.opLog.filter((o) => o.op === "mcp.open")).toHaveLength(2);
	});

	it("fails a call in flight when the machine disconnects, never hanging", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		const call = callMcpTool(
			{ name: "notes", url: urlOf(deviceId) },
			"hang",
			{},
			{ timeoutMs: 30_000 }
		);
		await vi.waitFor(() => expect(machine.mcpToolCalls).toHaveLength(1));
		const started = Date.now();
		machine.close();
		await expect(call).rejects.toThrow();
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	it("answers a frame for an unknown channel with closed, and a refused open with the machine's reason", async () => {
		const machine = connectorsMachine([{ ...notes, state: "disabled" }]);
		const deviceId = await pair(machine);
		await expect(getClient({ name: "notes", url: urlOf(deviceId) })).rejects.toThrow(
			/forbidden|disabled/i
		);
	});
});

describe("whose connector it is", () => {
	it("refuses a transport for another person's device, and a revoked or pending one", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		const stranger = await createTestUser();

		await expect(createLocalTransport(urlOf(deviceId, "notes", stranger))).rejects.toThrow(
			/no such machine/i
		);
		await expect(
			getClient({ name: "notes", url: urlOf(deviceId, "notes", stranger) })
		).rejects.toThrow();
		// Nothing was opened on the machine for the stranger.
		expect(machine.opLog.some((o) => o.op === "mcp.open")).toBe(false);

		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { status: "revoked" } }
		);
		await expect(createLocalTransport(urlOf(deviceId))).rejects.toThrow(/no such machine/i);
	});

	it("lists only the caller's own machines and servers; another person gets 404 on approve and revoke", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		const stranger = await createTestUser();

		const mine = await (
			await testRequest(listGET, { path: "/api/v2/local-connectors", locals: user.locals })
		).json();
		expect(mine.machines.map((m: { id: string }) => m.id)).toEqual([deviceId]);

		const theirs = await (
			await testRequest(listGET, { path: "/api/v2/local-connectors", locals: stranger.locals })
		).json();
		expect(theirs.machines).toEqual([]);

		const theirConnectors = await (
			await testRequest(connectorsGET, { path: "/api/v2/mcp/connectors", locals: stranger.locals })
		).json();
		expect(theirConnectors.data.some((c: { id: string }) => c.id.startsWith("local:"))).toBe(false);

		for (const handler of [machinePATCH, machineDELETE]) {
			const res = await testRequest(handler, {
				method: handler === machinePATCH ? "PATCH" : "DELETE",
				path: `/api/v2/local-connectors/machines/${deviceId}`,
				headers: { "content-type": "application/json" },
				body: handler === machinePATCH ? JSON.stringify({ action: "confirm" }) : undefined,
				locals: stranger.locals,
				params: { id: deviceId },
			});
			expect(res.status).toBe(404);
		}
		expect(isMachineOnline(deviceId)).toBe(true);
	});

	it("never selects another person's connector into a turn", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		const stranger = await createTestUser();
		const locals = await mcpLocalsFor(
			{ connectorIds: [`local:${deviceId}:notes`], customServers: [] },
			stranger.user._id
		);
		expect(locals.selectedServers).toEqual([]);
		expect(locals.unavailable).toEqual([]);
	});

	it("drops a machine:// address a browser supplied as a custom server", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		const { withoutClientCredentials } = await import("$lib/server/mcp/selection");
		expect(
			withoutClientCredentials([
				{ name: "x", url: urlOf(deviceId) },
				{ name: "ok", url: "https://example.com/mcp" },
			])
		).toEqual([{ name: "ok", url: "https://example.com/mcp" }]);
		const locals = await mcpLocalsFor(
			{ connectorIds: [], customServers: [{ name: "x", url: urlOf(deviceId) }] },
			user.user._id
		);
		expect(locals.selectedServers).toEqual([]);
	});
});

describe("the MCP panel's list and a turn's selection", () => {
	it("lists a machine's server as '<server> · on <machine>', connected while online and ready", async () => {
		const machine = connectorsMachine([
			notes,
			{
				name: "crm",
				transport: "http",
				state: "needs-login",
				detail: "Run `galopin connectors login crm` on this machine.",
			},
		]);
		const deviceId = await pair(machine);
		const res = await testRequest(connectorsGET, {
			path: "/api/v2/mcp/connectors",
			locals: user.locals,
		});
		const { data } = await res.json();
		const local = data.filter((c: { local?: unknown }) => c.local);
		const byName = Object.fromEntries(
			local.map((c: { local: { server: string } }) => [c.local.server, c])
		);
		expect(byName.notes.id).toBe(`local:${deviceId}:notes`);
		expect(byName.notes.name).toBe("notes · on laptop");
		expect(byName.notes.connected).toBe(true);
		expect(byName.notes.local.state).toBe("ready");
		expect(byName.crm.connected).toBe(false);
		expect(byName.crm.local.state).toBe("needs-login");
		expect(byName.crm.canAuthorize).toBe(true);
	});

	it("shows an offline machine's servers as unavailable and leaves them out of the turn without waiting", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		// Read once while online, so the row remembers the servers.
		await testRequest(connectorsGET, { path: "/api/v2/mcp/connectors", locals: user.locals });
		await vi.waitFor(async () => {
			const row = await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) });
			expect(row?.mcpServers?.map((s) => s.name)).toEqual(["notes"]);
		});
		await offline(machine, deviceId);
		resetLocalListCache();

		const { data } = await (
			await testRequest(connectorsGET, { path: "/api/v2/mcp/connectors", locals: user.locals })
		).json();
		const entry = data.find((c: { id: string }) => c.id === `local:${deviceId}:notes`);
		expect(entry.connected).toBe(false);
		expect(entry.local.state).toBe("offline");
		expect(entry.local.detail).toMatch(/not connected/);

		const started = Date.now();
		const locals = await mcpLocalsFor(
			{ connectorIds: [`local:${deviceId}:notes`], customServers: [] },
			user.user._id
		);
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(locals.selectedServers).toEqual([]);
		expect(locals.unavailable).toEqual([
			{ name: "notes · on laptop", reason: "laptop is offline" },
		]);
	});

	it("selects a ready server by its id and names the ones that cannot be used", async () => {
		const machine = connectorsMachine([
			notes,
			{ name: "crm", transport: "http", state: "needs-login" },
			{ name: "old", state: "disabled" },
		]);
		const deviceId = await pair(machine);
		const locals = await mcpLocalsFor(
			{
				connectorIds: ["notes", "crm", "old"].map((s) => `local:${deviceId}:${s}`),
				serverNames: [],
				customServers: [],
			},
			user.user._id
		);
		expect(locals.selectedServers).toEqual([{ name: "notes · on laptop", url: urlOf(deviceId) }]);
		// Chosen by id, so in the turn whatever names the browser listed.
		expect(locals.selectedServerNames).toEqual(["notes · on laptop"]);
		expect(locals.unavailable.map((u) => u.name).sort()).toEqual([
			"crm · on laptop",
			"old · on laptop",
		]);
		expect(locals.unavailable.find((u) => u.name.startsWith("crm"))?.reason).toMatch(/sign-in/);
	});
});

describe("the switches", () => {
	it("hides everything and refuses a connectors machine when LOCAL_CONNECTORS_ENABLED is off", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		overrides.LOCAL_CONNECTORS_ENABLED = "false";

		expect(
			(await testRequest(listGET, { path: "/api/v2/local-connectors", locals: user.locals })).status
		).toBe(404);
		const { data } = await (
			await testRequest(connectorsGET, { path: "/api/v2/mcp/connectors", locals: user.locals })
		).json();
		expect(data.some((c: { local?: unknown }) => c.local)).toBe(false);
		const locals = await mcpLocalsFor(
			{ connectorIds: [`local:${deviceId}:notes`], customServers: [] },
			user.user._id
		);
		expect(locals.selectedServers).toEqual([]);
		await expect(createLocalTransport(urlOf(deviceId))).rejects.toThrow(/not enabled/i);

		// A new connectors machine is refused at its hello (4404: it retries, nothing revoked).
		principal = principalFor(user, "second");
		const second = connectorsMachine();
		const closed = new Promise<number>((resolve) => second.ws.on("close", (code) => resolve(code)));
		void second.hello().catch(() => {});
		expect(await closed).toBe(4404);
		expect(await collections.codeDevices.countDocuments({ machineId: principal.machineId })).toBe(
			0
		);
	});

	it("accepts a connectors machine with CODE_AGENTS_ENABLED off, and refuses an agent machine then", async () => {
		overrides.CODE_AGENTS_ENABLED = "false";
		const machine = connectorsMachine();
		const { deviceId } = await machine.hello();
		expect(isMachineOnline(deviceId)).toBe(true);

		principal = principalFor(user, "coder");
		const agent = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, {});
		openMachines.push(agent);
		const closed = new Promise<number>((resolve) => agent.ws.on("close", (code) => resolve(code)));
		void agent.hello().catch(() => {});
		expect(await closed).toBe(4404);
	});
});

describe("the Agents panel never sees a connectors machine", () => {
	it("leaves it out of the device list, pending or paired, and refuses to route agent ops to it", async () => {
		const machine = connectorsMachine();
		const { deviceId } = await machine.hello();
		expect((await listDevices(user.locals)).map((d) => d.id)).not.toContain(deviceId);
		await collections.codeDevices.updateOne(
			{ _id: new ObjectId(deviceId) },
			{ $set: { status: "paired", pairedAt: new Date() } }
		);
		expect((await listDevices(user.locals)).map((d) => d.id)).not.toContain(deviceId);

		// Agent ops are never routed to it: it answers every one `unsupported`, so the panel
		// must not even ask.
		await expect(getPairedDevice(user.locals, deviceId)).rejects.toMatchObject({ status: 404 });

		// An agent machine still lists.
		principal = principalFor(user, "coder");
		const agent = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, {});
		openMachines.push(agent);
		const { deviceId: agentId } = await agent.hello();
		expect((await listDevices(user.locals)).map((d) => d.id)).toEqual([agentId]);
	});
});

describe("approving and revoking", () => {
	it("approves a pending connectors machine only on a fresh sign-in", async () => {
		const machine = connectorsMachine();
		const { deviceId } = await machine.hello();
		await collections.sessions.updateOne(
			{ sessionId: user.locals.sessionId },
			{ $set: { authTime: new Date(Date.now() - 8 * 24 * 3600_000) } }
		);
		const stale = await testRequest(machinePATCH, {
			method: "PATCH",
			path: `/api/v2/local-connectors/machines/${deviceId}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
			locals: user.locals,
			params: { id: deviceId },
		});
		expect(stale.status).toBe(401);
		expect((await stale.json()).code).toBe("reauth_required");
		expect((await collections.codeDevices.findOne({ _id: new ObjectId(deviceId) }))?.status).toBe(
			"pending"
		);
	});

	it("offers nothing of a pending machine, and revoking closes its link and drops its servers", async () => {
		const machine = connectorsMachine();
		const { deviceId } = await machine.hello();
		const pending = await (
			await testRequest(listGET, { path: "/api/v2/local-connectors", locals: user.locals })
		).json();
		expect(pending.machines).toMatchObject([{ id: deviceId, status: "pending", servers: [] }]);
		expect(machine.opLog.some((o) => o.op === "mcp.list")).toBe(false);

		await machine.waitForPaired().catch(() => {});
		const approved = await testRequest(machinePATCH, {
			method: "PATCH",
			path: `/api/v2/local-connectors/machines/${deviceId}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
			locals: user.locals,
			params: { id: deviceId },
		});
		expect(approved.status).toBe(200);

		const revoked = await testRequest(machineDELETE, {
			method: "DELETE",
			path: `/api/v2/local-connectors/machines/${deviceId}`,
			locals: user.locals,
			params: { id: deviceId },
		});
		expect(revoked.status).toBe(200);
		await vi.waitFor(() => expect(isMachineOnline(deviceId)).toBe(false));
		const { machines } = await (
			await testRequest(listGET, { path: "/api/v2/local-connectors", locals: user.locals })
		).json();
		expect(machines).toEqual([]);
		const locals = await mcpLocalsFor(
			{ connectorIds: [`local:${deviceId}:notes`], customServers: [] },
			user.user._id
		);
		expect(locals.unavailable).toEqual([]);
	});
});

describe("signing in to a local http connector from the chat", () => {
	// Fresh per test: the fake machine flips a server to ready once a sign-in completes.
	let crm: FakeMcpServer;
	beforeEach(() => {
		crm = { name: "crm", transport: "http", state: "needs-login" };
	});

	async function start(owner: TestUser, deviceId: string, next?: string) {
		return testRequest(oauthStart, {
			method: "POST",
			path: "/api/v2/local-connectors/oauth/start",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ connectorId: `local:${deviceId}:crm`, ...(next ? { next } : {}) }),
			locals: owner.locals,
		});
	}

	function callback(owner: TestUser, params: Record<string, string>) {
		const query = new URLSearchParams(params).toString();
		return testRequest(oauthCallback, {
			path: `/api/v2/local-connectors/oauth/callback?${query}`,
			locals: owner.locals,
		});
	}

	it("sends the machine Cerea's own callback, returns its authorization URL and finishes with the code", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);

		const res = await start(user, deviceId, "/workspace?tab=mcp");
		expect(res.status).toBe(200);
		const { authorizeUrl } = await res.json();
		const url = new URL(authorizeUrl);
		expect(url.origin).toBe("https://auth.example.com");
		expect(url.searchParams.get("redirect_uri")).toBe(
			"https://chat.example.org/api/v2/local-connectors/oauth/callback"
		);
		const state = url.searchParams.get("state") as string;
		expect(machine.opLog.find((o) => o.op === "mcp.login")?.args).toEqual({
			server: "crm",
			redirectUri: "https://chat.example.org/api/v2/local-connectors/oauth/callback",
		});

		const back = await callback(user, { state, code: "zcode-9q" });
		expect(back.status).toBe(303);
		const location = new URL(back.headers.get("location") as string, "http://x");
		expect(location.pathname).toBe("/workspace");
		expect(location.searchParams.get("mcp")).toBe("connected");
		expect(location.searchParams.get("mcpConnector")).toBe(`local:${deviceId}:crm`);
		expect(machine.mcpLogins).toEqual([{ server: "crm", code: "zcode-9q", state }]);
		// Cerea kept nothing but the (now consumed) state: no token, no verifier. (The code is not
		// made of hex digits: the dump below holds random ids and uuids, and "c0de" turned up in
		// one now and then.)
		expect(await collections.localConnectorOauth.countDocuments({ state })).toBe(0);
		expect(JSON.stringify(await collections.codeDevices.find({}).toArray())).not.toContain(
			"zcode-9q"
		);
	});

	it("refuses a state started by another person, and leaves it for its owner", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);
		const { authorizeUrl } = await (await start(user, deviceId)).json();
		const state = new URL(authorizeUrl).searchParams.get("state") as string;

		const stranger = await createTestUser();
		const refused = await callback(stranger, { state, code: "zcode-9q" });
		expect(
			new URL(refused.headers.get("location") as string, "http://x").searchParams.get("mcp")
		).toBe("failed");
		expect(machine.mcpLogins).toEqual([]);
		// Still there for the person who started it.
		expect(await collections.localConnectorOauth.countDocuments({ state })).toBe(1);
		const ok = await callback(user, { state, code: "zcode-9q" });
		expect(new URL(ok.headers.get("location") as string, "http://x").searchParams.get("mcp")).toBe(
			"connected"
		);
	});

	it("refuses a state started in another session of the same person", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);
		const { authorizeUrl } = await (await start(user, deviceId)).json();
		const state = new URL(authorizeUrl).searchParams.get("state") as string;
		const refused = await testRequest(oauthCallback, {
			path: `/api/v2/local-connectors/oauth/callback?state=${state}&code=zcode-9q`,
			locals: { ...user.locals, sessionId: "another-session" },
		});
		expect(
			new URL(refused.headers.get("location") as string, "http://x").searchParams.get("mcpDetail")
		).toBe("expired");
		expect(machine.mcpLogins).toEqual([]);
	});

	it("refuses a reused state and an expired one", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);
		const { authorizeUrl } = await (await start(user, deviceId)).json();
		const state = new URL(authorizeUrl).searchParams.get("state") as string;
		const second = await (await start(user, deviceId)).json();
		const state2 = new URL(second.authorizeUrl).searchParams.get("state") as string;
		await callback(user, { state, code: "zcode-9q" });
		const reused = await callback(user, { state, code: "zcode-9q" });
		expect(
			new URL(reused.headers.get("location") as string, "http://x").searchParams.get("mcpDetail")
		).toBe("expired");
		expect(machine.mcpLogins).toHaveLength(1);

		await collections.localConnectorOauth.updateOne(
			{ state: state2 },
			{ $set: { expiresAt: new Date(Date.now() - 1000) } }
		);
		const expired = await callback(user, { state: state2, code: "zcode-9q" });
		expect(
			new URL(expired.headers.get("location") as string, "http://x").searchParams.get("mcpDetail")
		).toBe("expired");
		expect(machine.mcpLogins).toHaveLength(1);
	});

	it("says clearly that an offline machine cannot sign in, at the start and at the callback", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);
		const { authorizeUrl } = await (await start(user, deviceId)).json();
		const state = new URL(authorizeUrl).searchParams.get("state") as string;
		await offline(machine, deviceId);

		const res = await start(user, deviceId);
		expect(res.status).toBe(409);
		expect(await res.text()).toMatch(/laptop is offline/);

		const back = await callback(user, { state, code: "zcode-9q" });
		expect(
			new URL(back.headers.get("location") as string, "http://x").searchParams.get("mcpDetail")
		).toBe("offline");
	});

	it("refuses to start a sign-in on another person's machine or with no session", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);
		const stranger = await createTestUser();
		expect((await start(stranger, deviceId)).status).toBe(404);
		expect(machine.opLog.some((o) => o.op === "mcp.login")).toBe(false);
		const none = await callback(user, {});
		expect(none.status).toBe(303);
		expect(
			new URL(none.headers.get("location") as string, "http://x").searchParams.get("mcpDetail")
		).toBe("incomplete");
	});

	it("reports the machine's refusal of the code and keeps going", async () => {
		const machine = connectorsMachine([crm]);
		const deviceId = await pair(machine);
		const { authorizeUrl } = await (await start(user, deviceId)).json();
		const state = new URL(authorizeUrl).searchParams.get("state") as string;
		const back = await callback(user, { state, code: "bad" });
		const location = new URL(back.headers.get("location") as string, "http://x");
		expect(location.searchParams.get("mcp")).toBe("failed");
		expect(location.searchParams.get("mcpDetail")).toBe("machine");
	});
});

describe("GET /api/v2/local-connectors/tools", () => {
	const ask = (id: string, who: TestUser = user) =>
		testRequest(toolsGET, {
			method: "GET",
			path: `/api/v2/local-connectors/tools?id=${encodeURIComponent(id)}`,
			locals: who.locals,
		});

	it("lists the tools of the caller's own server, through the chat's cached listing", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		const res = await ask(`local:${deviceId}:notes`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { tools: { name: string; description?: string }[] };
		expect(body.tools.map((t) => t.name).sort()).toEqual(["echo", "hang"]);
		expect(body.tools.find((t) => t.name === "echo")?.description).toBe("Echo the text");
	});

	it("is a 404 for another person's local server, and never opens a channel to it", async () => {
		const other = await createTestUser();
		await collections.sessions.updateOne(
			{ sessionId: other.locals.sessionId },
			{ $set: { authTime: new Date() } }
		);
		principal = principalFor(other, "their laptop");
		const machine = connectorsMachine();
		const deviceId = await pair(machine, other);

		const res = await ask(`local:${deviceId}:notes`);
		expect(res.status).toBe(404);
		expect(machine.opLog.filter((o) => o.op === "mcp.open")).toHaveLength(0);
		// The owner still reaches it.
		expect((await ask(`local:${deviceId}:notes`, other)).status).toBe(200);
	});

	it("is a 404 for an id that is not a local connector, or names a machine that does not exist", async () => {
		expect((await ask("not-a-local-id")).status).toBe(404);
		expect((await ask(`local:${"0".repeat(24)}:notes`)).status).toBe(404);
	});

	it("answers with the reason when the machine is offline, and 404 when the switch is off", async () => {
		const machine = connectorsMachine();
		const deviceId = await pair(machine);
		await offline(machine, deviceId);
		const res = await ask(`local:${deviceId}:notes`);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { error: string }).error).toMatch(/offline/);

		overrides.LOCAL_CONNECTORS_ENABLED = "false";
		expect((await ask(`local:${deviceId}:notes`)).status).toBe(404);
	});
});
