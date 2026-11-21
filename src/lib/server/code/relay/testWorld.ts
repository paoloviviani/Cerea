/**
 * Test support for relayed coordination (ADR 0121): a real machine link over a real WebSocket,
 * real Mongo, the real forwarder route, and fake galopins (`tests/fake-machine.ts`). Several
 * computers of one owner, and one of a stranger, so the same-owner rules are exercised against
 * data, not stubs. Only used by specs.
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { WebSocketServer } from "ws";
import superjson from "superjson";
import { expect } from "vitest";
import { collections } from "$lib/server/database";
import {
	cleanupTestData,
	createTestUser,
	type TestUser,
} from "$lib/server/api/__tests__/testHelpers";
import { testRequest } from "$lib/server/__tests__/testRequest";
import { acceptMachineConnection } from "$lib/server/code/machines";
import type { MachinePrincipal } from "$lib/server/code/machineAuth";
import { FakeMachine } from "../../../../../tests/fake-machine";
import {
	GET as forwarderGET,
	POST as forwarderPOST,
} from "../../../../routes/api/v2/code/[...path]/+server";
import { PATCH as devicesPATCH } from "../../../../routes/api/v2/code/devices/+server";
import { resetRelayViews } from "./views";
import type { CallResFrame, Policy, Session } from "$lib/types/machineProtocol";

export interface Mach {
	machine: FakeMachine;
	deviceId: string;
	name: string;
	owner: TestUser;
}

export interface World {
	owner: TestUser;
	stranger: TestUser;
	/** The caller's computer, the target, a third of the owner's, and the stranger's. */
	a: Mach;
	b: Mach;
	c: Mach;
	s: Mach;
	connect(owner: TestUser, name: string, opts?: ConnectOptions): Promise<Mach>;
	stop(): Promise<void>;
}

export interface ConnectOptions {
	/** Skip the pairing confirmation: the machine stays pending. */
	unpaired?: boolean;
	/** hello.machine.capabilities.relayedCoordination (default true). */
	relay?: boolean;
	policy?: Partial<Policy>;
}

export async function startWorld(): Promise<World> {
	const wss = new WebSocketServer({ noServer: true });
	const http: Server = createServer();
	let principal: MachinePrincipal | undefined;
	http.on("upgrade", (req, socket, head) => {
		wss.handleUpgrade(req, socket, head, (ws) => {
			if (principal) acceptMachineConnection(ws, req, principal, "test-token");
		});
	});
	await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
	const address = http.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const open: FakeMachine[] = [];

	const owner = await createTestUser();
	const stranger = await createTestUser();

	const connect = async (who: TestUser, name: string, opts: ConnectOptions = {}): Promise<Mach> => {
		principal = {
			userId: who.user._id,
			sub: who.user.hfUserId ?? who.user._id.toString(),
			iss: "http://fake-issuer.invalid",
			exp: Math.floor(Date.now() / 1000) + 3600,
			machineId: randomUUID(),
			machineName: name,
		};
		const machine = new FakeMachine(
			`ws://127.0.0.1:${port}/api/v2/code/machine`,
			{},
			{
				machine: { capabilities: { relayedCoordination: opts.relay !== false } },
				policy: {
					workspaceRoots: [],
					allowFreeModels: false,
					relayedCoordination: "allowed",
					...opts.policy,
				},
			}
		);
		open.push(machine);
		const { deviceId } = await machine.hello();
		if (!opts.unpaired) {
			const res = await testRequest(devicesPATCH, {
				method: "PATCH",
				path: `/api/v2/code/devices?id=${deviceId}`,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ action: "confirm" }),
				locals: who.locals,
			});
			expect(res.status).toBe(200);
			await machine.waitForPaired();
		}
		machine.model.workspaces.push({
			id: `ws_${name}`,
			name: `${name}-repo`,
			path: `/repo/${name}`,
			createdAt: new Date().toISOString(),
			isGitRepo: false,
		});
		return { machine, deviceId, name, owner: who };
	};

	const a = await connect(owner, "desk");
	const b = await connect(owner, "laptop");
	const c = await connect(owner, "garage");
	const s = await connect(stranger, "stranger-box");
	resetRelayViews();

	return {
		owner,
		stranger,
		a,
		b,
		c,
		s,
		connect,
		async stop() {
			for (const m of open) m.close();
			wss.close();
			await new Promise<void>((resolve) => http.close(() => resolve()));
			await Promise.all([
				collections.codeDevices.deleteMany({}),
				collections.codeAudit.deleteMany({}),
				collections.codeRelayTickets.deleteMany({}),
				collections.codeRelayLedger.deleteMany({}),
				collections.codeRelayEvents.deleteMany({}),
			]);
			await cleanupTestData();
			resetRelayViews();
		},
	};
}

let sessionCounter = 0;

/** A session in a fake machine's model. `word` is the root's permission mode. */
export function seedSession(
	m: Mach,
	over: Partial<Session> & { id?: string; title?: string } = {}
): Session {
	const now = new Date().toISOString();
	const session: Session = {
		id: over.id ?? `ses_${m.name}_${++sessionCounter}`,
		workspaceId: m.machine.model.workspaces[0].id,
		backend: "opencode",
		title: over.title ?? "A session",
		status: "idle",
		pendingPermissions: 0,
		modeId: "build",
		modelId: null,
		permissionMode: "ask",
		parentId: null,
		createdAt: now,
		updatedAt: now,
		usage: null,
		...over,
	} as Session;
	m.machine.model.sessions.push(session);
	return session;
}

/** The forwarder route, called as the signed-in owner. */
export async function forward(
	who: TestUser,
	method: "GET" | "POST",
	urlPath: string,
	body?: unknown
): Promise<Response> {
	const rest = urlPath.replace(/^\/api\/v2\/code\//, "").split("?")[0];
	return testRequest(method === "GET" ? forwarderGET : forwarderPOST, {
		method,
		path: urlPath,
		headers: { "content-type": "application/json" },
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		locals: who.locals,
		params: { path: rest },
	});
}

/** The owner's answer to a card, through the real HTTP route. */
/** The hash the card for this ask carries (what the browser sends back with its answer). */
export async function ticketHashOf(
	deviceId: string,
	requestId: string
): Promise<string | undefined> {
	return (await collections.codeRelayTickets.findOne({ deviceId, requestId }))?.hash;
}

/**
 * The owner's answer to a card, through the real HTTP route. Like the browser, it sends back the
 * ticket hash its card carried (`ticket` undefined: the current record's; `null`: none; a string:
 * that one, e.g. the hash of a card the user saw earlier).
 */
export async function answer(
	m: Mach,
	sessionId: string,
	requestId: string,
	decision: "once" | "always" | "reject",
	who: TestUser = m.owner,
	ticket?: string | null,
	childSessionId?: string
): Promise<Response> {
	const sent =
		ticket === undefined ? await ticketHashOf(m.deviceId, requestId) : (ticket ?? undefined);
	return forward(
		who,
		"POST",
		`/api/v2/code/v1/agents/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}?device=${m.deviceId}`,
		{ decision, ...(sent ? { ticket: sent } : {}), ...(childSessionId ? { childSessionId } : {}) }
	);
}

export async function parseBody<T>(res: Response): Promise<T> {
	return superjson.parse(await res.text()) as T;
}

/** What galopin's relay ask carries (ADR 0121 section 4). */
export interface RelayMeta {
	op: "send" | "read" | "spawn";
	computerId?: string;
	sessionId?: string;
	workspaceId?: string;
	text?: string;
	prompt?: string;
	last?: number;
	title?: string;
	mode?: string;
	hop?: number;
	[extra: string]: unknown;
}

let askCounter = 0;

/** A caller galopin raises a relay card, as the real one does: a `permission.asked` event. */
export async function raiseRelayAsk(
	m: Mach,
	callerSessionId: string,
	meta: RelayMeta,
	opts: { id?: string; relayFlag?: boolean } = {}
): Promise<string> {
	const id = opts.id ?? `gp_t${++askCounter}`;
	const tool =
		meta.op === "send" ? "session_send" : meta.op === "read" ? "session_read" : "session_spawn";
	m.machine.pushEvent(callerSessionId, {
		kind: "permission.asked",
		request: {
			id,
			sessionId: callerSessionId,
			tool,
			title: "galopin's own title",
			patterns: [],
			always: [],
			metadata: {
				galopin: true,
				...(opts.relayFlag === false ? {} : { relay: true }),
				hop: 1,
				...meta,
			},
			class: "agents",
		},
	});
	return id;
}

/** Wait for Cerea to have recorded (or refused) the ticket of an ask. */
export async function waitForTicket(
	deviceId: string,
	requestId: string,
	timeoutMs = 5000
): Promise<NonNullable<Awaited<ReturnType<typeof collections.codeRelayTickets.findOne>>>> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		const t = await collections.codeRelayTickets.findOne({ deviceId, requestId });
		if (t) return t;
		if (Date.now() > end) throw new Error(`no ticket for ${requestId}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

type Ok = Extract<CallResFrame, { ok: true }>;
type Err = Extract<CallResFrame, { ok: false }>;
export const okResult = <T = unknown>(r: CallResFrame): T => {
	expect(r.ok, JSON.stringify(r)).toBe(true);
	return (r as Ok).result as T;
};
export const errOf = (r: CallResFrame): Err["error"] => {
	expect(r.ok, JSON.stringify(r)).toBe(false);
	return (r as Err).error;
};

export function newObjectId(): string {
	return new ObjectId().toHexString();
}
