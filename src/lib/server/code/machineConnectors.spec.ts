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
	connectorsNow,
	getUserList,
	getSessionConnectorKeys,
	listChoices,
	setUserList,
	mergeConnectorLists,
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

const connectorsNowFor = (dev: string) => connectorsNow(owner, dev, ROOT);
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
		await setUserList(owner, { keys: [key] });
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
		await setUserList(owner, { keys: [key] });
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
		await expect(setUserList(owner, { keys: [theirs] })).rejects.toBeInstanceOf(
			SessionConnectorsError
		);
		await setUserList(owner, { keys: [mine] });
		const offered = (await connectorOptions(owner, deviceId.toString())).map((o) => o.name);
		expect(offered).toContain("Mine");
		expect(offered).not.toContain("Theirs");
		// ... and even a row written around the API (a bug, a restore) lists nothing of theirs.
		await collections.codeSessionConnectors.updateOne(
			{ userId: owner, deviceId: "*", sessionId: "local-agents" },
			{
				$set: { keys: [mine, theirs], savedAt: new Date() },
				$setOnInsert: { createdAt: new Date() },
			},
			{ upsert: true }
		);
		const names = ok(await list()).connectors.map((c: { name: string }) => c.name);
		expect(names).toEqual(["Mine"]);
		const refused = err(await callTool(theirs, "find"));
		expect(refused.code).toBe("forbidden");
		expect(fake.call).not.toHaveBeenCalled();
	});

	it("applies the deployment's modes: Off hides an opted-in connector, On and locked show it", async () => {
		const dep = await addConnector(owner, "Dep Search", { scope: "deployment", auth: "none" });
		await setUserList(owner, { keys: [dep] });
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
		await setUserList(owner, { keys: [key] });
		await setSwitch(owner, key, false);
		expect(ok(await list()).connectors).toEqual([]);
		expect(err(await callTool(key, "find")).code).toBe("forbidden");
		await setSwitch(owner, key, true);
		expect(ok(await list()).connectors).toHaveLength(1);
	});

	it("leaves out a connector that needs a sign-in, and cannot opt in to it", async () => {
		const oauth = await addConnector(owner, "Notion", { auth: "oauth", tokenSealed: undefined });
		const options = (await listChoices(owner)).options;
		expect(options.find((o) => o.name === "Notion")).toMatchObject({
			unavailable: "needs sign-in",
		});
		await expect(setUserList(owner, { keys: [oauth] })).rejects.toBeInstanceOf(
			SessionConnectorsError
		);
	});

	it("says a connector's tools could not be listed instead of failing the whole list", async () => {
		const a = await addConnector(owner, "Aaa");
		const b = await addConnector(owner, "Bbb");
		await setUserList(owner, { keys: [a, b] });
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
		await setUserList(owner, { keys: [own] });
		expect(ok(await list()).local).toEqual(["notes"]);
		await expect(setUserList(owner, { keys: [other] })).rejects.toBeInstanceOf(
			SessionConnectorsError
		);
		await collections.codeSessionConnectors.updateOne(
			{ userId: owner, deviceId: "*", sessionId: "local-agents" },
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
		await setUserList(owner, { keys: [key] });
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
		await setUserList(owner, { keys: [key] });
		// callTool sends sessionId SUB with rootSessionId ROOT
		expect(ok(await callTool(key, "find")).isError).toBe(false);
	});

	it("refuses a connector the session was not opted in to, with the same user and data", async () => {
		const on = await addConnector(owner, "On");
		const off = await addConnector(owner, "Off");
		await setUserList(owner, { keys: [on] });
		expect(ok(await callTool(on, "find")).isError).toBe(false);
		expect(err(await callTool(off, "find")).code).toBe("forbidden");
		expect(fake.call).toHaveBeenCalledTimes(1);
	});

	it("refuses a tool the connector does not list", async () => {
		const key = await addConnector(owner, "Tracker");
		await setUserList(owner, { keys: [key] });
		expect(err(await callTool(key, "drop_table")).code).toBe("not_found");
		expect(fake.call).not.toHaveBeenCalled();
	});

	it("passes a tool's own error through as a result, and names non-text content", async () => {
		const key = await addConnector(owner, "Tracker");
		await setUserList(owner, { keys: [key] });
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
		await setUserList(owner, { keys: [key] });
		fake.call.mockResolvedValueOnce({ text: "x".repeat(MAX_RESULT_CHARS + 50), isError: false });
		const text = ok(await callTool(key, "find")).text as string;
		expect(text.length).toBeLessThan(MAX_RESULT_CHARS + 120);
		expect(text).toContain("[result cut:");
	});

	it("maps failures without the service's own words", async () => {
		const key = await addConnector(owner, "Tracker");
		await setUserList(owner, { keys: [key] });
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
		await setUserList(owner, { keys: [key] });
		await callTool(key, "find");
		expect(fake.call.mock.calls[0][3]).toMatchObject({ timeoutMs: 80_000 });
		for (let i = 1; i < MAX_CALLS_PER_MINUTE; i++) await callTool(key, "find");
		expect(err(await callTool(key, "find")).code).toBe("limit");
	});

	it("audits the connector and tool, never the arguments or the result", async () => {
		const key = await addConnector(owner, "Tracker");
		await setUserList(owner, { keys: [key] });
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

describe("the session's narrowing of the user's one list", () => {
	it("inherits the whole list, narrows per session, never widens, and clears when all are on again", async () => {
		const a = await addConnector(owner, "Aaa");
		const b = await addConnector(owner, "Bbb");
		const c = await addConnector(owner, "Ccc");
		const dev = deviceId.toString();
		expect(await getSessionConnectorKeys(owner, dev, ROOT)).toEqual([]);
		await setUserList(owner, { keys: [a, b] });
		expect((await getSessionConnectorKeys(owner, dev, ROOT)).sort()).toEqual([a, b].sort());
		await setSessionConnectorKeys(owner, dev, ROOT, [b]);
		expect(await getSessionConnectorKeys(owner, dev, ROOT)).toEqual([b]);
		expect(ok(await list()).connectors.map((x: { name: string }) => x.name)).toEqual(["Bbb"]);
		// Another session is untouched.
		expect((await getSessionConnectorKeys(owner, dev, "ses_other")).sort()).toEqual([a, b].sort());
		// A connector outside the list cannot be switched on for a session.
		await expect(setSessionConnectorKeys(owner, dev, ROOT, [b, c])).rejects.toBeInstanceOf(
			SessionConnectorsError
		);
		// One added to the list later is inherited by a session that narrowed earlier.
		await setUserList(owner, { keys: [a, b, c] });
		expect((await getSessionConnectorKeys(owner, dev, ROOT)).sort()).toEqual([b, c].sort());
		await setSessionConnectorKeys(owner, dev, ROOT, [a, b, c]);
		expect(
			await collections.codeSessionConnectors.countDocuments({ userId: owner, sessionId: ROOT })
		).toBe(0);
		// Narrowing everything off leaves the session with nothing.
		await setSessionConnectorKeys(owner, dev, ROOT, []);
		expect(ok(await list())).toEqual({ connectors: [], local: [] });
	});

	it("is owner-only: a stranger can neither read nor change the owner's session", async () => {
		const key = await addConnector(owner, "Tracker");
		await setUserList(owner, { keys: [key] });
		expect(await getSessionConnectorKeys(stranger, deviceId.toString(), ROOT)).toEqual([]);
		await expect(
			setSessionConnectorKeys(stranger, deviceId.toString(), ROOT, [key])
		).rejects.toBeInstanceOf(SessionConnectorsError);
	});

	it("scopes a computer's own server to that computer", async () => {
		const own = `local:${deviceId}:notes`;
		await setUserList(owner, { keys: [own] });
		expect(ok(await list()).local).toEqual(["notes"]);
		// The same list, asked for by another of the user's computers' sessions, serves nothing.
		const other = new ObjectId();
		expect((await connectorsNowFor(other.toString())).local).toEqual([]);
	});
});

describe("apps on the user's computers (galopin goose setup, ADR 0110)", () => {
	const localFrame = (op: string, args: Record<string, unknown> = {}): CallFrame =>
		frame(op, { source: "local-agent", ...args });

	it("offers nothing by default, then exactly the user's own listed connectors", async () => {
		const mine = await addConnector(owner, "Mine");
		const theirs = await addConnector(stranger, "Theirs");
		expect(
			ok(await handleConnectorCall(deviceId.toString(), localFrame("connector.list")))
		).toEqual({ connectors: [], local: [] });
		expect((await listChoices(owner)).options.map((o) => o.name)).toEqual(["Mine"]);
		await expect(setUserList(owner, { keys: [theirs] })).rejects.toBeInstanceOf(
			SessionConnectorsError
		);
		expect((await setUserList(owner, { keys: [mine] })).keys).toEqual([mine]);
		const listed = ok(await handleConnectorCall(deviceId.toString(), localFrame("connector.list")));
		expect(listed.connectors.map((c) => c.name)).toEqual(["Mine"]);
		await setUserList(owner, { keys: [] });
		expect((await getUserList(owner)).keys).toEqual([]);
	});

	it("is on by default, serves the same list as sessions, and nothing once the switch is off", async () => {
		const key = await addConnector(owner, "Shared");
		await setUserList(owner, { keys: [key] });
		expect((await getUserList(owner)).appsToo).toBe(true);
		// The same single list feeds a session ...
		expect(ok(await list()).connectors.map((c: { name: string }) => c.name)).toEqual(["Shared"]);
		// ... and apps on the computer; the call is audited as a local agent.
		const done = await handleConnectorCall(
			deviceId.toString(),
			localFrame("connector.call", { connector: key, tool: "find", arguments: {} })
		);
		expect(ok(done).isError).toBe(false);
		const rows = await collections.codeAudit.find({ deviceId }).toArray();
		expect(
			rows.some((r) => r.origin === "local-agent" && String(r.name).startsWith("local agent:"))
		).toBe(true);
		// Switch off: apps get nothing and are denied, sessions are unaffected.
		await setUserList(owner, { appsToo: false });
		expect(
			ok(await handleConnectorCall(deviceId.toString(), localFrame("connector.list")))
		).toEqual({ connectors: [], local: [] });
		fake.call.mockClear();
		const denied = err(
			await handleConnectorCall(
				deviceId.toString(),
				localFrame("connector.call", { connector: key, tool: "find", arguments: {} })
			)
		);
		expect(denied.code).toBe("forbidden");
		expect(fake.call).not.toHaveBeenCalled();
		expect(ok(await list()).connectors).toHaveLength(1);
		// The list itself is kept when the switch moves.
		expect((await getUserList(owner)).keys).toEqual([key]);
	});

	it("a session's narrowing does not touch what apps get", async () => {
		const key = await addConnector(owner, "Shared");
		await setUserList(owner, { keys: [key] });
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, []);
		expect(ok(await list()).connectors).toEqual([]);
		const listed = ok(await handleConnectorCall(deviceId.toString(), localFrame("connector.list")));
		expect(listed.connectors.map((c) => c.name)).toEqual(["Shared"]);
	});
});

describe("merging the old two lists (mergeConnectorLists)", () => {
	const row = (over: Record<string, unknown>) => ({
		_id: new ObjectId(),
		userId: owner,
		createdAt: new Date(),
		updatedAt: new Date(),
		...over,
	});

	it("makes the union of the old local-agents keys and every session's keys, once, and is idempotent", async () => {
		const a = await addConnector(owner, "Aaa");
		const b = await addConnector(owner, "Bbb");
		const c = await addConnector(owner, "Ccc");
		await collections.codeSessionConnectors.insertMany([
			row({ deviceId: "*", sessionId: "local-agents", keys: [a] }),
			row({ deviceId: deviceId.toString(), sessionId: "s1", keys: [a, b] }),
			row({ deviceId: deviceId.toString(), sessionId: "s2", keys: [c] }),
		] as never);
		expect(await mergeConnectorLists()).toBeGreaterThanOrEqual(1);
		const list1 = await getUserList(owner);
		expect(list1.keys.sort()).toEqual([a, b, c].sort());
		expect(list1.appsToo).toBe(true);
		// The old per-session rows are gone (no narrowing), and the list no longer expires.
		expect(
			await collections.codeSessionConnectors.countDocuments({
				userId: owner,
				deviceId: { $ne: "*" },
			})
		).toBe(0);
		const stored = await collections.codeSessionConnectors.findOne({
			userId: owner,
			deviceId: "*",
		});
		expect(stored?.updatedAt).toBeUndefined();
		expect(stored?.savedAt).toBeInstanceOf(Date);
		// Again: nothing changes.
		await mergeConnectorLists();
		expect((await getUserList(owner)).keys.sort()).toEqual([a, b, c].sort());
		// Narrowing written after the merge survives another run.
		await setSessionConnectorKeys(owner, deviceId.toString(), ROOT, [a]);
		await mergeConnectorLists();
		expect(await getSessionConnectorKeys(owner, deviceId.toString(), ROOT)).toEqual([a]);
	});
});
