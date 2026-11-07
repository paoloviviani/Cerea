/**
 * The MCP reverse path, Cerea's half (ADR 0108, item 3; PROTOCOL.md §5 family `connector`): what a
 * machine may list and call for a session. Real database and the real resolver (ADR 0104); only
 * the MCP traffic is faked. Every negative assertion is paired with a positive one on the same
 * data, so none passes for an unrelated reason.
 */
import { ObjectId } from "mongodb";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { collections, ready } from "$lib/server/database";
import { seal } from "$lib/server/mcp/secretBox";
import { setPolicy, setSwitch } from "$lib/server/mcp/deploymentModes";
import {
	handleConnectorCall,
	MAX_CALLS_PER_MINUTE,
	MAX_RESULT_CHARS,
	resetConnectorRate,
} from "./machineConnectors";
import {
	connectorOptions,
	getLocalAgentKeys,
	getSessionConnectorKeys,
	localAgentOptions,
	setLocalAgentKeys,
	setSessionConnectorKeys,
	SessionConnectorsError,
} from "./sessionConnectors";
import type { CallFrame, CallResFrame } from "$lib/types/machineProtocol";

const fake = vi.hoisted(() => ({
	call: vi.fn(),
	list: vi.fn(),
}));

vi.mock("$lib/server/codeEnabled", async (original) => ({
	...(await original<typeof import("$lib/server/codeEnabled")>()),
	localConnectorsEnabled: () => true,
}));
vi.mock("$lib/server/mcp/httpClient", async (original) => ({
	...(await original<typeof import("$lib/server/mcp/httpClient")>()),
	callMcpTool: fake.call,
}));
vi.mock("$lib/server/mcp/tools", async (original) => ({
	...(await original<typeof import("$lib/server/mcp/tools")>()),
	listMcpServerTools: fake.list,
}));

const SECRET = "tok-secret-9f2c";
const owner = new ObjectId();
const stranger = new ObjectId();
const deviceId = new ObjectId();
const strangerDeviceId = new ObjectId();
const ROOT = "ses_root";
const SUB = "ses_sub";

beforeAll(async () => {
	await ready;
}, 30000);

async function addConnector(
	userId: ObjectId,
	name: string,
	extra: Record<string, unknown> = {}
): Promise<string> {
	const _id = new ObjectId();
	await collections.mcpConnectors.insertOne({
		_id,
		userId,
		scope: "user",
		name,
		url: `https://${name.toLowerCase()}.test/mcp`,
		auth: "token",
		tokenSealed: seal(SECRET),
		createdAt: new Date(),
		updatedAt: new Date(),
		...extra,
	} as never);
	return `connector:${_id}`;
}

function frame(op: string, args: Record<string, unknown> = {}, session = ROOT): CallFrame {
	return {
		type: "call",
		id: "c1",
		op,
		sessionId: session,
		rootSessionId: ROOT,
		caller: { workspaceId: "w", permissionMode: "ask", coordination: [] },
		args,
	};
}

type Ok = Extract<CallResFrame, { ok: true }>;
type Err = Extract<CallResFrame, { ok: false }>;
type ListItem = { id: string; name: string; tools: unknown[]; note?: string };
type Result = { connectors: ListItem[]; local: string[]; isError: boolean; text: string };
const ok = (r: CallResFrame) => {
	expect(r.ok, JSON.stringify(r)).toBe(true);
	return (r as Ok).result as Result;
};
const err = (r: CallResFrame) => {
	expect(r.ok, JSON.stringify(r)).toBe(false);
	return (r as Err).error;
};

const list = (deviceHex = deviceId.toString()) =>
	handleConnectorCall(deviceHex, frame("connector.list"));
const callTool = (key: string, tool: string, args: Record<string, unknown> = {}) =>
	handleConnectorCall(
		deviceId.toString(),
		frame("connector.call", { connector: key, tool, arguments: args }, SUB)
	);

beforeEach(async () => {
	resetConnectorRate();
	fake.call.mockReset();
	fake.list.mockReset();
	fake.list.mockResolvedValue([
		{ name: "find", description: "find issues", inputSchema: { type: "object" } },
	]);
	fake.call.mockResolvedValue({ text: "3 issues", isError: false });
	await Promise.all([
		collections.mcpConnectors.deleteMany({ userId: { $in: [owner, stranger] } }),
		collections.mcpConnectors.deleteMany({ scope: "deployment", name: /^Dep/ }),
		collections.mcpTokens.deleteMany({ userId: { $in: [owner, stranger] } }),
		collections.connectorSwitches.deleteMany({ userId: { $in: [owner, stranger] } }),
		collections.codeSessionConnectors.deleteMany({ userId: { $in: [owner, stranger] } }),
		collections.codeDevices.deleteMany({ _id: { $in: [deviceId, strangerDeviceId] } }),
		collections.codeAudit.deleteMany({ deviceId }),
	]);
	await collections.codeDevices.insertMany([
		{
			_id: deviceId,
			userId: owner,
			machineId: `m-${deviceId}`,
			status: "paired",
			name: "studio",
			machine: { capabilities: { mcp: true } },
			mcpServers: [{ name: "notes", transport: "stdio", state: "ready" }],
		},
		{
			_id: strangerDeviceId,
			userId: stranger,
			machineId: `m-${strangerDeviceId}`,
			status: "paired",
			name: "theirs",
		},
	] as never);
});

afterEach(async () => {
	await collections.mcpConnectors.deleteMany({ scope: "deployment", name: /^Dep/ });
	await collections.connectorModes.deleteMany({ key: /^connector:/ });
});

describe("connector.list", () => {
	it("is empty by default, however many connectors the user has, and lists the opted-in one after", async () => {
		const key = await addConnector(owner, "Tracker");
		expect(ok(await list())).toEqual({ connectors: [], local: [] });
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		const result = ok(await list());
		expect(result.connectors).toHaveLength(1);
		expect(result.connectors[0]).toMatchObject({
			id: key,
			name: "Tracker",
			tools: [{ name: "find", description: "find issues", inputSchema: { type: "object" } }],
		});
	});

	it("never carries a credential, a header or a url", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		const body = JSON.stringify(await list());
		expect(body).toContain("Tracker");
		for (const secret of [SECRET, "Bearer", "Authorization", "tracker.test"]) {
			expect(body).not.toContain(secret);
		}
	});

	it("never lists another user's connector, and cannot be made to by naming its key", async () => {
		const mine = await addConnector(owner, "Mine");
		const theirs = await addConnector(stranger, "Theirs");
		// The API refuses to opt in to it ...
		await expect(
			setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [theirs])
		).rejects.toBeInstanceOf(SessionConnectorsError);
		const offered = (await connectorOptions(owner, deviceId.toString())).map((o) => o.name);
		expect(offered).toContain("Mine");
		expect(offered).not.toContain("Theirs");
		// ... and even a row written around the API (a bug, a restore) lists nothing of theirs.
		await collections.codeSessionConnectors.insertOne({
			_id: new ObjectId(),
			userId: owner,
			deviceId: deviceId.toString(),
			sessionId: ROOT,
			keys: [mine, theirs],
			createdAt: new Date(),
			updatedAt: new Date(),
		});
		const names = ok(await list()).connectors.map((c: { name: string }) => c.name);
		expect(names).toEqual(["Mine"]);
		const refused = err(await callTool(theirs, "find"));
		expect(refused.code).toBe("forbidden");
		expect(fake.call).not.toHaveBeenCalled();
	});

	it("applies the deployment's modes: Off hides an opted-in connector, On and locked show it", async () => {
		const dep = await addConnector(owner, "Dep Search", { scope: "deployment", auth: "none" });
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [dep]);
		expect(ok(await list()).connectors.map((c: { name: string }) => c.name)).toEqual([
			"Dep Search",
		]);
		await setPolicy(dep, { mode: "locked" });
		expect(ok(await list()).connectors).toHaveLength(1);
		await setPolicy(dep, { mode: "off" });
		expect(ok(await list()).connectors).toEqual([]);
		expect(err(await callTool(dep, "find")).code).toBe("forbidden");
		expect(fake.call).not.toHaveBeenCalled();
		await setPolicy(dep, { mode: "on" });
		expect(ok(await list()).connectors).toHaveLength(1);
	});

	it("honours the user's own switch in Workspace, even for a connector opted in earlier", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		await setSwitch(owner, key, false);
		expect(ok(await list()).connectors).toEqual([]);
		expect(err(await callTool(key, "find")).code).toBe("forbidden");
		await setSwitch(owner, key, true);
		expect(ok(await list()).connectors).toHaveLength(1);
	});

	it("leaves out a connector that needs a sign-in, and cannot opt in to it", async () => {
		const oauth = await addConnector(owner, "Notion", { auth: "oauth", tokenSealed: undefined });
		const options = await connectorOptions(owner, deviceId.toString());
		expect(options.find((o) => o.name === "Notion")).toMatchObject({
			unavailable: "needs sign-in",
		});
		await expect(
			setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [oauth])
		).rejects.toBeInstanceOf(SessionConnectorsError);
	});

	it("says a connector's tools could not be listed instead of failing the whole list", async () => {
		const a = await addConnector(owner, "Aaa");
		const b = await addConnector(owner, "Bbb");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [a, b]);
		fake.list.mockRejectedValueOnce(new Error("ECONNREFUSED secret.internal:9"));
		const result = ok(await list());
		expect(result.connectors).toHaveLength(2);
		const broken = result.connectors.find((c: { tools: unknown[] }) => c.tools.length === 0);
		expect(broken?.note).toBe("its tools could not be listed right now");
		expect(JSON.stringify(result)).not.toContain("secret.internal");
	});

	it("offers the session's own machine's servers by name, and never another machine's", async () => {
		const own = `local:${deviceId}:notes`;
		const other = `local:${strangerDeviceId}:notes`;
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [own]);
		expect(ok(await list()).local).toEqual(["notes"]);
		await expect(
			setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [other])
		).rejects.toBeInstanceOf(SessionConnectorsError);
		await collections.codeSessionConnectors.updateOne(
			{ userId: owner, sessionId: ROOT },
			{ $set: { keys: [other] } }
		);
		expect(ok(await list()).local).toEqual([]);
	});

	it("refuses an unpaired or unknown machine", async () => {
		await collections.codeDevices.updateOne({ _id: deviceId }, { $set: { status: "pending" } });
		expect(err(await list()).code).toBe("forbidden");
		expect(err(await list(new ObjectId().toString())).code).toBe("forbidden");
	});
});

describe("connector.call", () => {
	it("runs the tool with the user's own credential, which stays on the server", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		const result = ok(await callTool(key, "find", { q: "bug" }));
		expect(result).toEqual({ isError: false, text: "3 issues" });
		expect(fake.call).toHaveBeenCalledTimes(1);
		const [server, tool, args] = fake.call.mock.calls[0];
		expect(server.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
		expect(tool).toBe("find");
		expect(args).toEqual({ q: "bug" });
		expect(JSON.stringify(result)).not.toContain(SECRET);
	});

	it("answers for a subagent through its root's opt-in", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		// callTool sends sessionId SUB with rootSessionId ROOT
		expect(ok(await callTool(key, "find")).isError).toBe(false);
	});

	it("refuses a connector the session was not opted in to, with the same user and data", async () => {
		const on = await addConnector(owner, "On");
		const off = await addConnector(owner, "Off");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [on]);
		expect(ok(await callTool(on, "find")).isError).toBe(false);
		expect(err(await callTool(off, "find")).code).toBe("forbidden");
		expect(fake.call).toHaveBeenCalledTimes(1);
	});

	it("refuses a tool the connector does not list", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		expect(err(await callTool(key, "drop_table")).code).toBe("not_found");
		expect(fake.call).not.toHaveBeenCalled();
	});

	it("passes a tool's own error through as a result, and names non-text content", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		fake.call.mockResolvedValueOnce({ text: "rate limited", isError: true });
		expect(ok(await callTool(key, "find"))).toEqual({ isError: true, text: "rate limited" });
		fake.call.mockResolvedValueOnce({
			text: "a",
			isError: false,
			content: [
				{ type: "text", text: "a" },
				{ type: "image", data: "AAAA" },
			],
		});
		expect(ok(await callTool(key, "find")).text).toBe("a\n[image content not shown]");
	});

	it("cuts an oversize result and says so", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		fake.call.mockResolvedValueOnce({ text: "x".repeat(MAX_RESULT_CHARS + 50), isError: false });
		const text = ok(await callTool(key, "find")).text as string;
		expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 120);
		expect(text).toContain("[result cut:");
	});

	it("maps failures without the service's own words", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		fake.call.mockRejectedValueOnce(
			new Error("HTTP 401 Unauthorized https://tracker.test/mcp?token=zzz")
		);
		const refused = err(await callTool(key, "find"));
		expect(refused.code).toBe("forbidden");
		expect(refused.message).toContain("reconnect");
		expect(refused.message).not.toContain("zzz");
		fake.call.mockRejectedValueOnce(new Error("Tool call exceeded 80000ms without a response"));
		expect(err(await callTool(key, "find")).code).toBe("unavailable");
		fake.call.mockRejectedValueOnce(new Error("socket hang up at 10.0.0.5"));
		const down = err(await callTool(key, "find"));
		expect(down.code).toBe("unavailable");
		expect(down.message).not.toContain("10.0.0.5");
	});

	it("bounds the call in time and rate", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		await callTool(key, "find");
		expect(fake.call.mock.calls[0][3]).toMatchObject({ timeoutMs: 80_000 });
		for (let i = 1; i < MAX_CALLS_PER_MINUTE; i++) await callTool(key, "find");
		expect(err(await callTool(key, "find")).code).toBe("limit");
	});

	it("audits the connector and tool, never the arguments or the result", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		await callTool(key, "find", { q: "private-question" });
		const rows = await collections.codeAudit.find({ deviceId, action: "connector.call" }).toArray();
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			outcome: "ok",
			origin: "agent",
			sessionId: SUB,
			name: "Tracker: find",
		});
		expect(JSON.stringify(rows[0])).not.toContain("private-question");
	});

	it("rejects malformed arguments", async () => {
		expect(
			err(await handleConnectorCall(deviceId.toString(), frame("connector.call", { tool: "x" })))
				.code
		).toBe("invalid");
	});
});

describe("the opt-in", () => {
	it("defaults to none, is replaced as a whole, and clears with an empty list", async () => {
		const a = await addConnector(owner, "Aaa");
		const b = await addConnector(owner, "Bbb");
		const dev = deviceId.toString();
		expect(await getSessionConnectorKeys(owner, dev, ROOT)).toEqual([]);
		await setSessionConnectorKeys(owner, dev, ROOT, [a, b, a]);
		expect((await getSessionConnectorKeys(owner, dev, ROOT)).sort()).toEqual([a, b].sort());
		await setSessionConnectorKeys(owner, dev, ROOT, [b]);
		expect(await getSessionConnectorKeys(owner, dev, ROOT)).toEqual([b]);
		await setSessionConnectorKeys(owner, dev, ROOT, []);
		expect(await getSessionConnectorKeys(owner, dev, ROOT)).toEqual([]);
		// Another session is untouched by all of it.
		expect(await getSessionConnectorKeys(owner, dev, "ses_other")).toEqual([]);
	});

	it("is owner-only: a stranger can neither read nor change the owner's session", async () => {
		const key = await addConnector(owner, "Tracker");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [key]);
		expect(await getSessionConnectorKeys(stranger, deviceId.toString(), ROOT)).toEqual([]);
		await addConnector(stranger, "Theirs");
		await expect(
			setSessionConnectorKeys(stranger, deviceId.toString(), ROOT, [key])
		).rejects.toBeInstanceOf(SessionConnectorsError);
	});
});

describe("local agents (galopin goose setup, ADR 0110)", () => {
	const localFrame = (op: string, args: Record<string, unknown> = {}): CallFrame =>
		frame(op, { source: "local-agent", ...args });

	it("offers nothing by default, then exactly the user's own switched-on connectors", async () => {
		const mine = await addConnector(owner, "Mine");
		const theirs = await addConnector(stranger, "Theirs");
		expect(
			ok(await handleConnectorCall(deviceId.toString(), localFrame("connector.list")))
		).toEqual({ connectors: [], local: [] });
		expect((await localAgentOptions(owner)).map((o) => o.name)).toEqual(["Mine"]);
		await expect(setLocalAgentKeys(owner, [theirs])).rejects.toBeInstanceOf(SessionConnectorsError);
		expect(await setLocalAgentKeys(owner, [mine])).toEqual([mine]);
		const listed = ok(await handleConnectorCall(deviceId.toString(), localFrame("connector.list")));
		expect(listed.connectors.map((c) => c.name)).toEqual(["Mine"]);
		await setLocalAgentKeys(owner, []);
		expect(await getLocalAgentKeys(owner)).toEqual([]);
	});

	it("is separate from a session's opt-in, and the call is audited as a local agent", async () => {
		const sessionOnly = await addConnector(owner, "SessionOnly");
		const localOnly = await addConnector(owner, "LocalOnly");
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [sessionOnly]);
		await setLocalAgentKeys(owner, [localOnly]);
		const denied = err(
			await handleConnectorCall(
				deviceId.toString(),
				localFrame("connector.call", { connector: sessionOnly, tool: "find", arguments: {} })
			)
		);
		expect(denied.code).toBe("forbidden");
		expect(fake.call).not.toHaveBeenCalled();
		const done = await handleConnectorCall(
			deviceId.toString(),
			localFrame("connector.call", { connector: localOnly, tool: "find", arguments: {} })
		);
		expect(ok(done).isError).toBe(false);
		expect(fake.call).toHaveBeenCalledTimes(1);
		const rows = await collections.codeAudit.find({ deviceId }).toArray();
		expect(
			rows.some((r) => r.origin === "local-agent" && String(r.name).startsWith("local agent:"))
		).toBe(true);
		// A session's list does not see the local-only connector.
		expect(ok(await list()).connectors.map((c) => c.name)).toEqual(["SessionOnly"]);
	});
});
