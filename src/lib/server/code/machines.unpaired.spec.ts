/**
 * Server-initiated work on a machine that is not paired yet (audit L3): its events start no
 * reviewer run and no push, and the link answers no op for the server. Once the browser
 * confirms it, both work. Driven against a fake machine over a real WebSocket.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const observed = vi.hoisted(() => vi.fn());
vi.mock("$lib/server/push/watch", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/push/watch")>()),
	observeMachineEvent: observed,
}));

const { ready } = await import("$lib/server/database");
const { createTestUser, cleanupTestData } = await import("$lib/server/api/__tests__/testHelpers");
type TestUser = Awaited<ReturnType<typeof createTestUser>>;
const { testRequest } = await import("$lib/server/__tests__/testRequest");
const { acceptMachineConnection, MachineLink } = await import("$lib/server/code/machines");
const { FakeMachine } = await import("../../../../tests/fake-machine");
const { PATCH: devicesPATCH } = await import("../../../routes/api/v2/code/devices/+server");

let httpServer: Server;
let wss: WebSocketServer;
let port: number;
let user: TestUser;
let principal: Parameters<typeof acceptMachineConnection>[2];
const open: Array<InstanceType<typeof FakeMachine>> = [];

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

beforeEach(async () => {
	observed.mockClear();
	user = await createTestUser();
	principal = {
		userId: user.user._id,
		sub: user.user.hfUserId,
		iss: "http://fake-issuer.invalid",
		exp: Math.floor(Date.now() / 1000) + 3600,
		machineId: randomUUID(),
		machineName: "fake machine",
	};
});

afterEach(async () => {
	for (const m of open.splice(0)) m.close();
	await cleanupTestData();
});

const ask = {
	kind: "permission.asked" as const,
	request: {
		id: "perm-1",
		sessionId: "s1",
		tool: "bash",
		title: "run",
		patterns: ["ls"],
		metadata: {},
		always: [],
	},
};

describe("a machine that is not paired", () => {
	it("starts no reviewer or push from its events, and the server can call nothing on it", async () => {
		const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		open.push(machine);
		const { deviceId, status } = await machine.hello();
		expect(status).toBe("pending");

		machine.pushEvent("s1", ask);
		await new Promise((r) => setTimeout(r, 150));
		expect(observed).not.toHaveBeenCalled();

		await expect(new MachineLink(deviceId).workspaceList()).rejects.toThrow(/not confirmed/);

		// Confirmed in the browser: events are observed and ops go through.
		const res = await testRequest(devicesPATCH, {
			method: "PATCH",
			path: `/api/v2/code/devices?id=${deviceId}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
			locals: user.locals,
		});
		expect(res.status).toBe(200);
		await machine.waitForPaired();
		machine.pushEvent("s1", { ...ask, request: { ...ask.request, id: "perm-2" } });
		await vi.waitFor(() => expect(observed).toHaveBeenCalledTimes(1));
	});
});
