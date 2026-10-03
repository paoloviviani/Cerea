/**
 * The forwarder and the SSE bridge, driven end to end against a fake
 * machine (`tests/fake-machine.ts`) over a real WebSocket — the same
 * `acceptMachineConnection` the production upgrade path calls, just fed by
 * a hand-rolled `http`/`ws` server instead of `server.js`'s. Bearer
 * validation has its own dedicated spec (`machineAuth.spec.ts`); this one
 * starts from an already-authenticated principal so it can focus on the
 * registry, the forwarder's op mapping and the bridge's cursor.
 */
import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import superjson from "superjson";
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { ObjectId } from "mongodb";
import { collections, ready } from "$lib/server/database";
import {
	createTestUser,
	cleanupTestData,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest, TEST_ORIGIN } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine, type FakeMachineOptions } from "../../../../../../tests/fake-machine";
import { OpError } from "$lib/types/machineProtocol";
import { GET as forwarderGET, POST as forwarderPOST } from "../[...path]/+server";
import { PATCH as devicesPATCH } from "../devices/+server";
import { GET as streamGET } from "../agents/[id]/stream/+server";

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

beforeEach(async () => {
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

/** Every machine this file connects, so a test that fails mid-way (an
 * assertion throws before its own `machine.close()` runs) never leaves a
 * live socket pinning `httpServer.close()` in `afterAll` — that hung the
 * whole suite for 30s the one time an assertion below failed. */
let openMachines: FakeMachine[] = [];

afterEach(async () => {
	for (const machine of openMachines) machine.close();
	openMachines = [];
	await cleanupTestData();
});

async function parse<T>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

/** `testRequest` stubs SvelteKit's own routing (its module doc: "only
 * path-to-handler routing is stubbed"), so a `[...path]` catch-all handler
 * needs its rest param supplied by hand — this derives it from the URL so
 * every forwarder call in this file gets it right by construction.
 * `json: false` still sends an Origin (a body-carrying `Request` with no
 * explicit content-type defaults to `text/plain`, and the real hook's own
 * CSRF guard 403s a same-origin-less native-form content type before this
 * route ever sees the request — this exercises the forwarder's own
 * `requireJsonBody`, not the hook's separate guard). */
async function forwarder(
	handler: typeof forwarderGET,
	urlPath: string,
	opts: { method?: string; body?: string; json?: boolean; locals: App.Locals; signal?: AbortSignal }
): Promise<Response> {
	const restPath = urlPath.replace(/^\/api\/v2\/code\//, "").split("?")[0];
	return testRequest(handler, {
		method: opts.method,
		path: urlPath,
		body: opts.body,
		headers: opts.json === false ? { origin: TEST_ORIGIN } : { "content-type": "application/json" },
		locals: opts.locals,
		signal: opts.signal,
		params: { path: restPath },
	});
}

/** Connect a fake machine, let it reach `pending`, confirm it through the
 * real endpoint (the same click the Agents panel's Confirm button makes),
 * and wait for the `status: paired` push. */
async function connectAndPair(options: FakeMachineOptions = {}): Promise<FakeMachine> {
	const machine = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {}, options);
	openMachines.push(machine);
	const { deviceId, status } = await machine.hello();
	expect(status).toBe("pending");

	const res = await testRequest(devicesPATCH, {
		method: "PATCH",
		path: `/api/v2/code/devices?id=${deviceId}`,
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ action: "confirm" }),
		locals: user.locals,
	});
	expect(res.status).toBe(200);
	await machine.waitForPaired();
	return machine;
}

describe("the forwarder over a live machine link", () => {
	it("creates a workspace and a session, and lists them back", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;

		const wsRes = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ path: "/repo", title: "repo" }),
			locals: user.locals,
		});
		expect(wsRes.status).toBe(200);
		const { workspace } = await parse<{ workspace: { id: string; name: string } }>(wsRes);
		expect(workspace.name).toBe("repo");
		expect(machine.model.workspaces).toHaveLength(1);

		const agentRes = await forwarder(forwarderPOST, `/api/v2/code/v1/agents?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ workspaceId: workspace.id, provider: "opencode", posture: "plan" }),
			locals: user.locals,
		});
		expect(agentRes.status).toBe(200);
		const { agent } = await parse<{ agent: { id: string; modeId: string | null } }>(agentRes);
		expect(agent.modeId).toBe("plan");

		const listRes = await forwarder(forwarderGET, `/api/v2/code/v1/agents?device=${deviceId}`, {
			locals: user.locals,
		});
		const { agents } = await parse<{ agents: Array<{ id: string }> }>(listRes);
		expect(agents.map((a) => a.id)).toContain(agent.id);

		machine.close();
	});

	it("mints a clientMessageId server-side when the browser sends none", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const promptArgs: Array<{ clientMessageId?: string }> = [];
		machine.onOp("session.prompt", (args: { clientMessageId?: string }) => {
			promptArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/messages?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({ text: "hello" }), locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(promptArgs).toHaveLength(1);
		expect(promptArgs[0].clientMessageId).toEqual(expect.any(String));
		expect(promptArgs[0].clientMessageId).not.toBe("");

		machine.close();
	});

	it("passes through an explicit messageId instead of minting one", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const promptArgs: Array<{ clientMessageId?: string }> = [];
		machine.onOp("session.prompt", (args: { clientMessageId?: string }) => {
			promptArgs.push(args);
			return {};
		});

		await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/messages?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ text: "hello", messageId: "browser-mid-1" }),
				locals: user.locals,
			}
		);
		expect(promptArgs[0].clientMessageId).toBe("browser-mid-1");

		machine.close();
	});

	it("calls session.compact for the /compact route (M3)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const compactArgs: unknown[] = [];
		machine.onOp("session.compact", (args: unknown) => {
			compactArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/compact?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({}), locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(compactArgs).toEqual([{ sessionId: agent.id }]);

		machine.close();
	});

	describe("the read-only file explorer (ADR 0090)", () => {
		const POLICY = { workspaceRoots: [], allowFreeModels: false };

		it("forwards a listing and serves an image raw, sandboxed and audited", async () => {
			const machine = await connectAndPair({
				machine: { capabilities: { files: true } },
				policy: { ...POLICY, files: "read" },
			});
			const deviceId = machine.deviceId as string;
			const { workspace } = await createWorkspace(machine, deviceId);
			const listArgs: unknown[] = [];
			machine.onOp("files.list", (args: unknown) => {
				listArgs.push(args);
				return { path: "src", entries: [], truncated: false };
			});
			machine.onOp("files.read", (args: { path: string }) =>
				args.path === "pic.png"
					? {
							path: "pic.png",
							revision: "1",
							size: 3,
							offset: 0,
							length: 3,
							eof: true,
							kind: "image",
							mime: "image/png",
							encoding: "base64",
							content: Buffer.from("PNG").toString("base64"),
						}
					: {
							path: args.path,
							revision: "1",
							size: 2,
							offset: 0,
							length: 2,
							eof: true,
							kind: "text",
							mime: "text/html",
							encoding: "utf-8",
							content: "<script>alert(1)</script>",
						}
			);

			const list = await forwarder(
				forwarderGET,
				`/api/v2/code/v1/workspaces/${workspace.id}/files?device=${deviceId}&path=src`,
				{ locals: user.locals }
			);
			expect(list.status).toBe(200);
			expect(listArgs).toEqual([{ workspaceId: workspace.id, path: "src", ignored: true }]);

			const raw = await forwarder(
				forwarderGET,
				`/api/v2/code/v1/workspaces/${workspace.id}/files/raw?device=${deviceId}&path=pic.png`,
				{ locals: user.locals }
			);
			expect(raw.status).toBe(200);
			expect(raw.headers.get("content-type")).toBe("image/png");
			expect(raw.headers.get("x-content-type-options")).toBe("nosniff");
			expect(raw.headers.get("content-security-policy")).toContain("sandbox");
			expect(Buffer.from(await raw.arrayBuffer()).toString()).toBe("PNG");

			// HTML (or SVG) from a repository is never served as itself.
			const html = await forwarder(
				forwarderGET,
				`/api/v2/code/v1/workspaces/${workspace.id}/files/raw?device=${deviceId}&path=x.html`,
				{ locals: user.locals }
			);
			expect(html.status).toBe(415);

			const audited = await collections.codeAudit
				.find({ deviceId: new ObjectId(deviceId) })
				.toArray();
			expect(audited.map((a) => [a.action, a.path, a.bytes])).toEqual([
				["files.raw", "pic.png", 3],
			]);
			expect(JSON.stringify(audited)).not.toContain("PNG");
			machine.close();
		});

		it("refuses, and audits the refusal, on a machine enrolled with --no-files", async () => {
			const machine = await connectAndPair({
				machine: { capabilities: { files: true } },
				policy: { ...POLICY, files: "off" },
			});
			const deviceId = machine.deviceId as string;
			const { workspace } = await createWorkspace(machine, deviceId);
			let forwarded = false;
			machine.onOp("files.list", () => {
				forwarded = true;
				return { path: ".", entries: [], truncated: false };
			});
			const res = await forwarder(
				forwarderGET,
				`/api/v2/code/v1/workspaces/${workspace.id}/files?device=${deviceId}`,
				{ locals: user.locals }
			);
			expect(res.status).toBe(403);
			expect(await res.text()).toContain("--no-files");
			expect(forwarded).toBe(false);
			const audited = await collections.codeAudit.findOne({ deviceId: new ObjectId(deviceId) });
			expect(audited?.action).toBe("files.refused");
			machine.close();
		});
	});

	it("forwards /effort as session.setEffort, null clearing it, and refuses a malformed body", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const calls: unknown[] = [];
		machine.onOp("session.setEffort", (args: unknown) => {
			calls.push(args);
			return { session: { id: agent.id } };
		});
		for (const effort of ["high", null]) {
			const res = await forwarder(
				forwarderPOST,
				`/api/v2/code/v1/agents/${agent.id}/effort?device=${deviceId}`,
				{ method: "POST", body: JSON.stringify({ effort }), locals: user.locals }
			);
			expect(res.status).toBe(200);
		}
		expect(calls).toEqual([
			{ sessionId: agent.id, effort: "high" },
			{ sessionId: agent.id, effort: null },
		]);
		const bad = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/effort?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({}), locals: user.locals }
		);
		expect(bad.status).toBe(400);

		machine.close();
	});

	it("forwards /revert and /unrevert, and refuses a revert with no messageId", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const calls: Array<{ op: string; args: unknown }> = [];
		machine.onOp("session.revert", (args: unknown) => {
			calls.push({ op: "revert", args });
			return {};
		});
		machine.onOp("session.unrevert", (args: unknown) => {
			calls.push({ op: "unrevert", args });
			return {};
		});

		const revert = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/revert?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({ messageId: "msg_2" }), locals: user.locals }
		);
		expect(revert.status).toBe(200);
		const unrevert = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/unrevert?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({}), locals: user.locals }
		);
		expect(unrevert.status).toBe(200);
		expect(calls).toEqual([
			{ op: "revert", args: { sessionId: agent.id, messageId: "msg_2" } },
			{ op: "unrevert", args: { sessionId: agent.id } },
		]);

		const bad = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/revert?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({}), locals: user.locals }
		);
		expect(bad.status).toBe(400);

		machine.close();
	});

	it("answers a machine question, translating accept/answers into question.reply (user-question tool)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const replyArgs: unknown[] = [];
		machine.onOp("question.reply", (args: unknown) => {
			replyArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/questions/q-1?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ decision: "accept", answers: [["npm"]] }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(200);
		expect(replyArgs).toEqual([
			{ sessionId: agent.id, requestId: "q-1", decision: "answer", answers: [["npm"]] },
		]);

		machine.close();
	});

	it("translates a declined machine question into question.reply's reject, with no answers", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const replyArgs: unknown[] = [];
		machine.onOp("question.reply", (args: unknown) => {
			replyArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/questions/q-1?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({ decision: "decline" }), locals: user.locals }
		);
		expect(res.status).toBe(200);
		expect(replyArgs).toEqual([{ sessionId: agent.id, requestId: "q-1", decision: "reject" }]);

		machine.close();
	});

	it("rejects a malformed question decision before it ever reaches the machine", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const replyArgs: unknown[] = [];
		machine.onOp("question.reply", (args: unknown) => {
			replyArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/questions/q-1?device=${deviceId}`,
			{ method: "POST", body: JSON.stringify({ decision: "maybe" }), locals: user.locals }
		);
		expect(res.status).toBe(400);
		expect(replyArgs).toHaveLength(0);

		machine.close();
	});

	it("rejects a non-JSON POST body before it ever reaches the machine (C5)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const res = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ path: "/repo" }),
			json: false,
			locals: user.locals,
		});
		expect(res.status).toBe(400);
		expect(machine.model.workspaces).toHaveLength(0);
		machine.close();
	});

	it("answers instantly, never a hang, once the machine goes offline (R1)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.close();
		// One tick for the server's own `close` handler to evict the registry
		// entry — no arbitrary polling loop, just the microtask/close event.
		await new Promise<void>((resolve) => setTimeout(resolve, 100));

		const start = Date.now();
		const res = await forwarder(forwarderGET, `/api/v2/code/v1/agents?device=${deviceId}`, {
			locals: user.locals,
		});
		expect(res.status).toBe(502);
		expect(Date.now() - start).toBeLessThan(2000);
	});

	it("hides non-gateway models and refuses them unless the machine allows free models", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);
		machine.onOp("backend.models", () => ({
			models: [
				{ id: "pystino/coder", label: "Coder", providerId: "pystino", isDefault: true },
				{ id: "opencode/free-model", label: "Free", providerId: "opencode" },
			],
		}));
		const setModelCalls: unknown[] = [];
		machine.onOp("session.setModel", (args: unknown) => {
			setModelCalls.push(args);
			return { session: {} };
		});

		const list = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/providers/opencode/models?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(list.status).toBe(200);
		const listed = await parse<{ models: Array<{ id: string }>; hidden: number }>(list);
		expect(listed.models.map((m) => m.id)).toEqual(["pystino/coder"]);
		expect(listed.hidden).toBe(1);

		const refused = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/model?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ modelId: "opencode/free-model" }),
				locals: user.locals,
			}
		);
		expect(refused.status).toBe(403);
		expect(setModelCalls).toHaveLength(0);

		machine.close();
	});

	it("refuses a device that belongs to a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const otherUser = await createTestUser();

		const res = await forwarder(forwarderGET, `/api/v2/code/v1/agents?device=${deviceId}`, {
			locals: otherUser.locals,
		});
		expect(res.status).toBe(404);
		machine.close();
	});

	it("suggests directories from the machine, filtered by prefix (M8)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		machine.model.directories = [
			{ path: "/home/you/repo-a", name: "repo-a", isGitRepo: true },
			{ path: "/home/you/repo-b", name: "repo-b", isGitRepo: false },
			{ path: "/home/you/other", name: "other", isGitRepo: false },
		];

		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/workspaces/suggest?prefix=${encodeURIComponent("/home/you/repo")}&device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		const { directories } = await parse<{
			directories: Array<{ name: string; isGitRepo: boolean }>;
		}>(res);
		expect(directories.map((d) => d.name).sort()).toEqual(["repo-a", "repo-b"]);
		expect(directories.find((d) => d.name === "repo-a")?.isGitRepo).toBe(true);

		machine.close();
	});

	it("creates a git worktree workspace, and archives it with removeWorktree (M8)", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);

		const wtRes = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ worktree: { from: workspace.id, branch: "feature/x" } }),
			locals: user.locals,
		});
		expect(wtRes.status).toBe(200);
		const { workspace: worktree } = await parse<{
			workspace: { id: string; worktreeOf?: string; branch?: string; isGitRepo: boolean };
		}>(wtRes);
		expect(worktree.worktreeOf).toBe(workspace.id);
		expect(worktree.branch).toBe("feature/x");
		expect(worktree.isGitRepo).toBe(true);
		expect(machine.model.workspaces).toHaveLength(2);

		const archiveRes = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/workspaces/${worktree.id}/archive?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ removeWorktree: true }),
				locals: user.locals,
			}
		);
		expect(archiveRes.status).toBe(200);
		expect(machine.model.workspaces.map((w) => w.id)).not.toContain(worktree.id);

		machine.close();
	});
});

describe("the handoff route (parity plan §4.2(a))", () => {
	it("hands off to a new session on the same device, carrying the chat history as an attachment", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent: source } = await createSession(machine, deviceId, workspace.id);

		machine.model.transcripts.set(source.id, {
			messages: [
				{
					message: { id: "m1", role: "user", createdAt: new Date().toISOString() },
					parts: [
						{
							id: "p1",
							messageId: "m1",
							role: "user",
							type: "text",
							text: "please refactor this",
						},
					],
				},
			],
			permissions: [],
			status: "idle",
			usage: null,
			todos: [],
		});

		const promptArgs: Array<{
			text: string;
			attachments?: Array<{ mime: string; filename: string; url: string }>;
		}> = [];
		machine.onOp("session.prompt", (args: (typeof promptArgs)[number]) => {
			promptArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${source.id}/handoff?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ prompt: "keep going", carry: true }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(200);
		const { agent, deviceId: answeredDeviceId } = await parse<{
			agent: { id: string; title: string; workspaceId: string };
			deviceId: string;
		}>(res);
		expect(answeredDeviceId).toBe(deviceId);
		expect(agent.title).toBe("Fork: New session");
		expect(agent.workspaceId).toBe(workspace.id);
		expect(agent.id).not.toBe(source.id);

		expect(promptArgs).toHaveLength(1);
		expect(promptArgs[0].text).toBe("keep going");
		expect(promptArgs[0].attachments).toHaveLength(1);
		const attachment = promptArgs[0].attachments?.[0];
		expect(attachment?.mime).toBe("text/markdown");
		expect(attachment?.filename).toBe("chat-history.md");
		const [, base64] = attachment?.url.split(",") ?? [];
		expect(Buffer.from(base64 ?? "", "base64").toString("utf8")).toContain("please refactor this");

		machine.close();
	});

	it("hands off across the caller's own paired devices", async () => {
		const source = await connectAndPair();
		// Two devices for the same user, so each needs its own machine id —
		// `connectAndPair` reuses whatever `principal.machineId` `beforeEach`
		// minted, which a second call without this would collide on and
		// resolve to the first device's already-`paired` row instead of a
		// fresh `pending` one.
		principal = { ...principal, machineId: randomUUID() };
		const target = await connectAndPair();
		const sourceDeviceId = source.deviceId as string;
		const targetDeviceId = target.deviceId as string;
		const { workspace: sourceWs } = await createWorkspace(source, sourceDeviceId);
		const { agent: sourceAgent } = await createSession(source, sourceDeviceId, sourceWs.id);
		const { workspace: targetWs } = await createWorkspace(target, targetDeviceId);

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${sourceAgent.id}/handoff?device=${sourceDeviceId}`,
			{
				method: "POST",
				body: JSON.stringify({
					prompt: "continue on this box",
					carry: false,
					targetDevice: targetDeviceId,
					workspaceId: targetWs.id,
				}),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(200);
		const { agent, deviceId: answeredDeviceId } = await parse<{
			agent: { id: string; workspaceId: string };
			deviceId: string;
		}>(res);
		expect(answeredDeviceId).toBe(targetDeviceId);
		expect(agent.workspaceId).toBe(targetWs.id);
		expect(target.model.sessions.map((s) => s.id)).toContain(agent.id);
		expect(source.model.sessions.map((s) => s.id)).not.toContain(agent.id);

		source.close();
		target.close();
	});

	it("refuses a target device owned by a different user", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const otherUser = await createTestUser();
		principal = { ...principal, userId: otherUser.user._id };
		const foreign = new FakeMachine(`ws://127.0.0.1:${port}/api/v2/code/machine`, {});
		openMachines.push(foreign);
		const { deviceId: foreignDeviceId } = await foreign.hello();
		await testRequest(devicesPATCH, {
			method: "PATCH",
			path: `/api/v2/code/devices?id=${foreignDeviceId}`,
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ action: "confirm" }),
			locals: otherUser.locals,
		});
		await foreign.waitForPaired();
		principal = { ...principal, userId: user.user._id };

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/handoff?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ prompt: "steal this", carry: false, targetDevice: foreignDeviceId }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(404);

		machine.close();
		foreign.close();
	});

	it("refuses a model the target device's policy disallows", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const createArgs: unknown[] = [];
		machine.onOp("session.create", (args: unknown) => {
			createArgs.push(args);
			return { session: {} };
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agent.id}/handoff?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ prompt: "go", carry: false, modelId: "opencode/free-model" }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(403);
		expect(createArgs).toHaveLength(0);

		machine.close();
	});
});

describe("the SSE bridge over a live machine link", () => {
	it("emits a session.sync's snapshot on connect, and a live event on the tail", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);

		const controller = new AbortController();
		const res = await testRequest(streamGET, {
			path: `/api/v2/code/agents/${agent.id}/stream?device=${deviceId}`,
			params: { id: agent.id },
			locals: user.locals,
			signal: controller.signal,
		});
		expect(res.status).toBe(200);

		const reader = res.body?.getReader();
		expect(reader).toBeTruthy();
		if (!reader) return;

		// The empty snapshot's own turn state ("idle" status -> done) arrives
		// first, with no live activity needed.
		const first = await readOneFrame(reader);
		expect(first.event).toBe("update");

		// A live permission event, pushed after the snapshot — the tail.
		machine.pushEvent(agent.id, {
			kind: "permission.asked",
			request: {
				id: "perm-1",
				sessionId: agent.id,
				tool: "bash",
				title: "run rm -rf build/",
				patterns: [],
				metadata: {},
				always: [],
			},
		});
		const second = await readOneFrame(reader);
		expect(JSON.parse(second.data).type).toBe("elicitation");

		controller.abort();
		await reader.cancel().catch(() => {});
		machine.close();
	});
});

/**
 * Tool-output images (PROTOCOL.md §6 session.attachment, §7 attachments): the
 * raw route is the one place a machine's bytes become something a browser
 * renders, so its refusals are the spec. The machine is untrusted: the type
 * comes from the bytes, the pixel count from the header, and the content must
 * hash to the sha asked for.
 */
describe("tool-output images through the forwarder", () => {
	const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

	function png(width: number, height: number, extra = 0): Buffer {
		const b = Buffer.alloc(33 + extra);
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
		Buffer.from([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]).copy(b, 8);
		b.writeUInt32BE(width, 16);
		b.writeUInt32BE(height, 20);
		return b;
	}

	async function attachmentSession() {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);
		return { machine, deviceId, agentId: agent.id };
	}

	function fetchImage(deviceId: string, agentId: string, digest: string, locals = user.locals) {
		return forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${agentId}/attachments/${digest}?device=${deviceId}`,
			{ locals }
		);
	}

	it("serves the image inline, sandboxed, cacheable per sha, and audits it without content", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		const image = png(64, 48, 100);
		const asked: unknown[] = [];
		machine.onOp("session.attachment", (args: unknown) => {
			asked.push(args);
			return { mime: "image/png", data: image.toString("base64") };
		});

		const res = await fetchImage(deviceId, agentId, sha(image));
		expect(res.status).toBe(200);
		expect(asked).toEqual([{ sessionId: agentId, sha256: sha(image) }]);
		expect(res.headers.get("content-type")).toBe("image/png");
		expect(res.headers.get("content-disposition")).toBe("inline");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("content-security-policy")).toBe("sandbox; default-src 'none'");
		expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
		expect(Buffer.from(await res.arrayBuffer()).equals(image)).toBe(true);

		const audited = await collections.codeAudit
			.find({ deviceId: new ObjectId(deviceId) })
			.toArray();
		expect(audited.map((a) => [a.action, a.path, a.bytes])).toEqual([
			["attachment.raw", `${agentId}/${sha(image)}`, image.length],
		]);
		expect(JSON.stringify(audited)).not.toContain(image.toString("base64").slice(0, 20));
		machine.close();
	});

	it("decides the type from the bytes: a PNG claimed as HTML is a PNG", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		const image = png(10, 10);
		machine.onOp("session.attachment", () => ({
			mime: "text/html",
			data: image.toString("base64"),
		}));
		const res = await fetchImage(deviceId, agentId, sha(image));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toBe("image/png");
		machine.close();
	});

	it("refuses SVG and HTML however they are labelled", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		for (const body of [
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
			"<!doctype html><script>alert(1)</script>",
		]) {
			const bytes = Buffer.from(body);
			machine.onOp("session.attachment", () => ({
				mime: "image/png",
				data: bytes.toString("base64"),
			}));
			const res = await fetchImage(deviceId, agentId, sha(bytes));
			expect(res.status).toBe(415);
			expect(res.headers.get("content-type")).not.toContain("image/");
		}
		machine.close();
	});

	it("refuses a decompression bomb by its header, before serving a byte", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		const bomb = png(60000, 60000); // ~3.6 gigapixels in 33 bytes
		machine.onOp("session.attachment", () => ({
			mime: "image/png",
			data: bomb.toString("base64"),
		}));
		const res = await fetchImage(deviceId, agentId, sha(bomb));
		expect(res.status).toBe(413);
		machine.close();
	});

	it("refuses an image over 8 MiB", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		const big = png(100, 100, 8 * 1024 * 1024);
		machine.onOp("session.attachment", () => ({ mime: "image/png", data: big.toString("base64") }));
		expect((await fetchImage(deviceId, agentId, sha(big))).status).toBe(413);
		machine.close();
	});

	it("refuses bytes that are not the image whose sha was asked for", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		const listed = png(20, 20, 5);
		const swapped = png(20, 20, 6);
		machine.onOp("session.attachment", () => ({
			mime: "image/png",
			data: swapped.toString("base64"),
		}));
		expect((await fetchImage(deviceId, agentId, sha(listed))).status).toBe(502);
		machine.close();
	});

	it("maps the machine's answers: gone or unknown is 404, no capability is 404", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		machine.onOp("session.attachment", () => {
			throw new OpError("not_found", "this image is no longer on the machine");
		});
		const gone = await fetchImage(deviceId, agentId, "c".repeat(64));
		expect(gone.status).toBe(404);
		machine.onOp("session.attachment", () => {
			throw new OpError("unsupported", "backend fake has no toolImages capability");
		});
		expect((await fetchImage(deviceId, agentId, "c".repeat(64))).status).toBe(404);
		machine.close();
	});

	it("only accepts a lowercase 64-hex sha in the path, and never asks the machine otherwise", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		let asked = false;
		machine.onOp("session.attachment", () => {
			asked = true;
			return { mime: "image/png", data: "" };
		});
		for (const bad of ["abc", "C".repeat(64), "c".repeat(63), "c".repeat(65), "..%2F..%2Fetc"]) {
			const res = await fetchImage(deviceId, agentId, bad);
			expect(res.status).toBeGreaterThanOrEqual(400);
		}
		expect(asked).toBe(false);
		machine.close();
	});

	it("is not a capability: another person's request for this machine's image is refused", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		let asked = false;
		const image = png(8, 8);
		machine.onOp("session.attachment", () => {
			asked = true;
			return { mime: "image/png", data: image.toString("base64") };
		});
		const other = await createTestUser();
		const res = await fetchImage(deviceId, agentId, sha(image), other.locals);
		expect(res.status).toBeGreaterThanOrEqual(400);
		expect(res.status).not.toBe(200);
		expect(asked).toBe(false);
		machine.close();
	});

	it("carries the images to a reloaded view as urls, with no bytes on the stream", async () => {
		const { machine, deviceId, agentId } = await attachmentSession();
		const image = png(32, 32, 50);
		const digest = sha(image);
		machine.onOp("session.sync", () => ({
			epoch: "e1",
			seq: 3,
			snapshot: {
				messages: [
					{
						message: { id: "m1", role: "assistant", createdAt: new Date().toISOString() },
						parts: [
							{
								id: "p1",
								messageId: "m1",
								role: "assistant",
								type: "tool",
								callId: "call-1",
								tool: "playwright_screenshot",
								status: "completed",
								input: {},
								output: "ok",
								attachments: [{ sha256: digest, mime: "image/png", size: image.length }],
							},
						],
					},
				],
				permissions: [],
				questions: [],
				status: "idle",
				usage: null,
				todos: [],
			},
		}));

		const controller = new AbortController();
		const res = await testRequest(streamGET, {
			path: `/api/v2/code/agents/${agentId}/stream?device=${deviceId}`,
			params: { id: agentId },
			locals: user.locals,
			signal: controller.signal,
		});
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no stream body");
		let seen = "";
		for (let i = 0; i < 6 && !seen.includes(digest); i++) seen += (await readOneFrame(reader)).data;
		expect(seen).toContain(
			`/api/v2/code/v1/agents/${agentId}/attachments/${digest}?device=${deviceId}`
		);
		expect(seen).not.toContain(image.toString("base64").slice(0, 24));
		controller.abort();
		await reader.cancel().catch(() => {});
		machine.close();
	});
});

async function createWorkspace(
	_machine: FakeMachine,
	deviceId: string
): Promise<{ workspace: { id: string; name: string; path: string } }> {
	const res = await forwarder(forwarderPOST, `/api/v2/code/v1/workspaces?device=${deviceId}`, {
		method: "POST",
		body: JSON.stringify({ path: "/repo", title: "repo" }),
		locals: user.locals,
	});
	return parse(res);
}

async function createSession(
	_machine: FakeMachine,
	deviceId: string,
	workspaceId: string
): Promise<{ agent: { id: string } }> {
	const res = await forwarder(forwarderPOST, `/api/v2/code/v1/agents?device=${deviceId}`, {
		method: "POST",
		body: JSON.stringify({ workspaceId, provider: "opencode", posture: "plan" }),
		locals: user.locals,
	});
	return parse(res);
}

interface SseFrame {
	id?: string;
	event: string;
	data: string;
}

/** Read from the SSE stream until one full `\n\n`-terminated frame (an
 * `event:`/`data:` pair, or a heartbeat comment) is available, and return it
 * parsed. Heartbeats (`: heartbeat`) are skipped. */
async function readOneFrame(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	timeoutMs = 10_000
): Promise<SseFrame> {
	const decoder = new TextDecoder();
	let buffer = "";
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (Date.now() > deadline) throw new Error("timed out waiting for an SSE frame");
		const { value, done } = await reader.read();
		if (done) throw new Error("stream ended before a frame arrived");
		buffer += decoder.decode(value, { stream: true });
		const sep = buffer.indexOf("\n\n");
		if (sep === -1) continue;
		const raw = buffer.slice(0, sep);
		buffer = buffer.slice(sep + 2);
		if (raw.startsWith(":")) continue; // heartbeat comment
		const frame: SseFrame = { event: "message", data: "" };
		for (const line of raw.split("\n")) {
			if (line.startsWith("id: ")) frame.id = line.slice(4);
			else if (line.startsWith("event: ")) frame.event = line.slice(7);
			else if (line.startsWith("data: ")) frame.data = line.slice(6);
		}
		return frame;
	}
}

/**
 * The slash commands' two rows (PROTOCOL.md §6 backend.commands /
 * session.command): the listing maps the machine's Command shape onto the
 * panel's (and never carries a template), a run is zod-shaped, audited with
 * the command's own facts and never its arguments, and the machine's gate
 * refusals land on their statuses — 404 unknown, 409 changed-since-review,
 * 403 policy (the copy names the enroll flag), 400 invalid.
 */
describe("the slash commands' forwarder rows", () => {
	function commandFixture(overrides: Record<string, unknown> = {}) {
		return {
			name: "deploy",
			description: "ship it",
			source: "command",
			origin: "project",
			hints: ["$ARGUMENTS"],
			shell: true,
			shellSnippets: ["echo hello"],
			fileRefs: ["notes.md"],
			templateHash: "a".repeat(64),
			...overrides,
		};
	}

	async function machineWithCommands(options: Record<string, unknown> = {}) {
		const machine = await connectAndPair();
		machine.model.commands = [commandFixture(options) as never];
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);
		return { machine, deviceId, agentId: agent.id };
	}

	it("lists the session workspace's commands with their shell facts, and never a template", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${agentId}/commands?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(200);
		const { commands } = await parse<{ commands: Array<Record<string, unknown>> }>(res);
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({
			name: "deploy",
			origin: "project",
			shell: true,
			shellSnippets: ["echo hello"],
			templateHash: "a".repeat(64),
		});
		// The template itself never crosses this wire (PROTOCOL.md §6): the
		// snippets are what a person must see.
		expect(JSON.stringify(commands[0])).not.toContain("template:");
		machine.close();
	});

	it("maps a capability-less machine to 404, which the menu reads as panel-only", async () => {
		const machine = await connectAndPair();
		const deviceId = machine.deviceId as string;
		const { workspace } = await createWorkspace(machine, deviceId);
		const { agent } = await createSession(machine, deviceId, workspace.id);
		// An old galopin without the capability answers `unsupported`
		// (PROTOCOL.md §6) — the forwarder maps that to the 404 the
		// composer reads as "panel commands only".
		machine.onOp("backend.commands", () => {
			throw new OpError("unsupported", "backend fake cannot list commands");
		});
		const res = await forwarder(
			forwarderGET,
			`/api/v2/code/v1/agents/${agent.id}/commands?device=${deviceId}`,
			{ locals: user.locals }
		);
		expect(res.status).toBe(404);
		machine.close();
	});

	it("runs a command: the op carries the arguments verbatim, a minted clientMessageId, and the templateHash", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		const commandArgs: Array<Record<string, unknown>> = [];
		machine.onOp("session.command", (args: Record<string, unknown>) => {
			commandArgs.push(args);
			return {};
		});

		const res = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ name: "deploy", arguments: "--env prod" }),
				locals: user.locals,
			}
		);
		expect(res.status).toBe(200);
		expect(commandArgs).toHaveLength(1);
		expect(commandArgs[0].name).toBe("deploy");
		expect(commandArgs[0].arguments).toBe("--env prod");
		expect(commandArgs[0].clientMessageId).toEqual(expect.any(String));
		// No templateHash travels unless the caller confirmed one (the
		// confirmation sheet's accept): the machine answers conflict on a
		// hash it disagrees with, and this run confirmed nothing.
		expect(commandArgs[0].templateHash).toBeUndefined();
		machine.close();
	});

	it("audits the run with the command's own facts, and never its arguments", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		machine.onOp("session.command", () => ({}));
		await forwarder(forwarderPOST, `/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ name: "deploy", arguments: "--env SECRET-VALUE" }),
			locals: user.locals,
		});
		const rows = await collections.codeAudit
			.find({ action: "code.command" })
			.sort({ _id: -1 })
			.limit(1)
			.toArray();
		expect(rows).toHaveLength(1);
		const row = rows[0] as Record<string, unknown>;
		expect(row.name).toBe("deploy");
		expect(row.origin).toBe("project");
		expect(row.shell).toBe("true");
		expect(row.outcome).toBe("run");
		expect(String(row.deviceId)).toBe(deviceId);
		expect(JSON.stringify(row)).not.toContain("SECRET-VALUE");
		expect(JSON.stringify(rows[0])).not.toContain("SECRET-VALUE");
		machine.close();
	});

	it("audits a wire-null shell as unknown, not false", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		machine.model.commands = [
			commandFixture({ name: "plain", shell: undefined, shellSnippets: undefined }) as never,
		];
		machine.onOp("session.command", () => ({}));
		await forwarder(forwarderPOST, `/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ name: "plain", arguments: "" }),
			locals: user.locals,
		});
		const rows = await collections.codeAudit
			.find({ action: "code.command" })
			.sort({ _id: -1 })
			.limit(1)
			.toArray();
		expect(rows).toHaveLength(1);
		expect((rows[0] as Record<string, unknown>).shell).toBe("unknown");
		machine.close();
	});

	it("audits a refused run with the machine's refusal code", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		machine.onOp("session.command", () => {
			throw new OpError("conflict", "changed");
		});
		await forwarder(forwarderPOST, `/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`, {
			method: "POST",
			body: JSON.stringify({ name: "deploy", arguments: "" }),
			locals: user.locals,
		});
		const rows = await collections.codeAudit
			.find({ action: "code.command" })
			.sort({ _id: -1 })
			.limit(1)
			.toArray();
		expect(rows).toHaveLength(1);
		expect((rows[0] as Record<string, unknown>).outcome).toBe("conflict");
		machine.close();
	});

	it("refuses a malformed name with 400, and an unknown one with 404", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		const bad = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ name: "-nope", arguments: "" }),
				locals: user.locals,
			}
		);
		expect(bad.status).toBe(400);

		const unknown = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ name: "absent", arguments: "" }),
				locals: user.locals,
			}
		);
		expect(unknown.status).toBe(404);
		machine.close();
	});

	it("maps the machine's gate refusals: 409 conflict, 403 policy with the enroll flag named", async () => {
		const { machine, deviceId, agentId } = await machineWithCommands();
		machine.onOp("session.command", () => {
			throw new OpError(
				"conflict",
				"this command changed on the machine since it was reviewed; review it again"
			);
		});
		const conflict = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ name: "deploy", arguments: "" }),
				locals: user.locals,
			}
		);
		expect(conflict.status).toBe(409);
		expect(((await conflict.json()) as { message: string }).message).toContain("review it again");

		machine.onOp("session.command", () => {
			throw new OpError(
				"forbidden",
				"this command's template runs shell, and this machine denies command shell: re-enroll without --no-command-shell to allow it"
			);
		});
		const forbidden = await forwarder(
			forwarderPOST,
			`/api/v2/code/v1/agents/${agentId}/command?device=${deviceId}`,
			{
				method: "POST",
				body: JSON.stringify({ name: "deploy", arguments: "" }),
				locals: user.locals,
			}
		);
		expect(forbidden.status).toBe(403);
		expect(((await forbidden.json()) as { message: string }).message).toContain(
			"--no-command-shell"
		);
		machine.close();
	});
});
