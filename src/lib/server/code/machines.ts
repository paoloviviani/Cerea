/**
 * The machine registry: one live WebSocket per paired machine, in process,
 * plus the typed request/response layer (`MachineLink`) and the event
 * fan-out the SSE bridge subscribes to.
 *
 * Nothing here is a capability at rest — the registry is a plain in-memory
 * `Map`, lost on restart, and the only thing a Mongo dump of `codeDevices`
 * yields is names and ids (review C4). A `MachineLink` for an offline
 * machine still constructs and still answers every call: instantly, with an
 * `unavailable` rejection, never a hang (R1) — the registry is checked
 * first, and nothing here ever attempts a connection outward.
 */

import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { ObjectId } from "mongodb";
import { collections } from "$lib/server/database";
import { logger } from "$lib/server/logger";
import { revalidateMachineAuth, type MachinePrincipal } from "$lib/server/code/machineAuth";
import {
	parseMachineFrame,
	opDeadlineMs,
	OpError,
	type Backend,
	type Envelope,
	type FileDiff,
	type Mode,
	type Model,
	type OpName,
	type Policy,
	type Session,
	type SyncResult,
	type Workspace,
} from "$lib/types/machineProtocol";
import type { CodeDevice } from "$lib/types/CodeAgent";

const HELLO_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 20_000;
const PONG_DEAD_AFTER_MS = 60_000;
const RENEWAL_GRACE_MS = 60_000;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

interface ConnectionState {
	deviceId: string;
	ws: WebSocket;
	principal: MachinePrincipal;
	backends: Backend[];
	policy: Policy;
	pending: Map<string, PendingRequest>;
	listeners: Map<string, Set<(envelope: Envelope) => void>>;
	authDeadline: ReturnType<typeof setTimeout> | null;
	pingInterval: ReturnType<typeof setInterval> | null;
	lastPongAt: number;
}

/** deviceId (the codeDevices row's hex _id) → its one live connection. */
const registry = new Map<string, ConnectionState>();

export function isMachineOnline(deviceId: string): boolean {
	return registry.has(deviceId);
}

export function deviceBackends(deviceId: string): Backend[] | null {
	return registry.get(deviceId)?.backends ?? null;
}

export function devicePolicy(deviceId: string): Policy | null {
	return registry.get(deviceId)?.policy ?? null;
}

function closeConnection(state: ConnectionState, code: number, reason: string): void {
	if (state.authDeadline) clearTimeout(state.authDeadline);
	if (state.pingInterval) clearInterval(state.pingInterval);
	for (const pending of state.pending.values()) {
		clearTimeout(pending.timer);
		pending.reject(new OpError("unavailable", "The machine link closed."));
	}
	state.pending.clear();
	try {
		state.ws.close(code, reason);
	} catch {
		// already closing
	}
	// Only drop the registry entry if this connection is still the current
	// one for its device — a stale `close` from a connection already
	// replaced by a newer one (4409) must not evict the newer one.
	if (registry.get(state.deviceId) === state) {
		registry.delete(state.deviceId);
	}
}

export function dropMachineConnection(deviceId: string, code: number, reason: string): void {
	const state = registry.get(deviceId);
	if (state) closeConnection(state, code, reason);
}

/** Sent once the browser confirms a pending machine (spec §4). A no-op if
 * the machine is not currently connected — it will see its row's `paired`
 * status the next time it connects instead. */
export function notifyDevicePaired(deviceId: string): void {
	const state = registry.get(deviceId);
	if (!state) return;
	try {
		state.ws.send(JSON.stringify({ type: "status", status: "paired" }));
	} catch (err) {
		logger.warn({ err, deviceId }, "machine link: failed to push paired status");
	}
}

function scheduleAuthDeadline(state: ConnectionState): void {
	if (state.authDeadline) clearTimeout(state.authDeadline);
	const deadlineMs = state.principal.exp * 1000 + RENEWAL_GRACE_MS - Date.now();
	state.authDeadline = setTimeout(
		() => {
			logger.warn({ deviceId: state.deviceId }, "machine link: auth renewal deadline passed");
			closeConnection(state, 4401, "token expired and was not renewed");
		},
		Math.max(0, deadlineMs)
	);
}

function sendRequest<TResult>(state: ConnectionState, op: OpName, args: unknown): Promise<TResult> {
	return new Promise((resolve, reject) => {
		const id = randomUUID();
		const timer = setTimeout(() => {
			state.pending.delete(id);
			reject(new OpError("unavailable", `Timed out waiting for ${op} to answer.`));
		}, opDeadlineMs(op));
		state.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
		try {
			state.ws.send(JSON.stringify({ type: "req", id, op, args }));
		} catch (err) {
			clearTimeout(timer);
			state.pending.delete(id);
			reject(err instanceof Error ? err : new Error(String(err)));
		}
	});
}

/**
 * Typed methods, one per op in spec §6. A `MachineLink` is cheap to
 * construct for any deviceId — every method looks the live connection up in
 * the registry at call time, so a link built for an offline machine answers
 * every call with an instant `unavailable` `OpError` rather than a hang.
 */
export class MachineLink {
	constructor(private readonly deviceId: string) {}

	private call<TResult>(op: OpName, args: unknown): Promise<TResult> {
		const state = registry.get(this.deviceId);
		if (!state) {
			return Promise.reject(new OpError("unavailable", "This machine is not connected."));
		}
		return sendRequest<TResult>(state, op, args);
	}

	workspaceList(): Promise<{ workspaces: Workspace[] }> {
		return this.call("workspace.list", {});
	}
	workspaceCreate(args: { path: string; title?: string }): Promise<{ workspace: Workspace }> {
		return this.call("workspace.create", args);
	}
	workspaceRename(args: { workspaceId: string; title: string }): Promise<{ workspace: Workspace }> {
		return this.call("workspace.rename", args);
	}
	workspaceArchive(args: { workspaceId: string }): Promise<Record<string, never>> {
		return this.call("workspace.archive", args);
	}
	sessionList(args: { workspaceId?: string } = {}): Promise<{ sessions: Session[] }> {
		return this.call("session.list", args);
	}
	sessionGet(args: { sessionId: string }): Promise<{ session: Session }> {
		return this.call("session.get", args);
	}
	sessionCreate(args: {
		workspaceId: string;
		backend?: string;
		title?: string;
		modeId?: string;
		modelId?: string;
	}): Promise<{ session: Session }> {
		return this.call("session.create", args);
	}
	sessionPrompt(args: {
		sessionId: string;
		text: string;
		clientMessageId?: string;
		attachments?: Array<{ type: "file"; mime: string; filename: string; url: string }>;
	}): Promise<Record<string, never>> {
		return this.call("session.prompt", args);
	}
	sessionCancel(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.cancel", args);
	}
	sessionRename(args: { sessionId: string; title: string }): Promise<{ session: Session }> {
		return this.call("session.rename", args);
	}
	sessionArchive(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.archive", args);
	}
	sessionDelete(args: { sessionId: string }): Promise<Record<string, never>> {
		return this.call("session.delete", args);
	}
	sessionSetMode(args: { sessionId: string; modeId: string }): Promise<{ session: Session }> {
		return this.call("session.setMode", args);
	}
	sessionSetModel(args: { sessionId: string; modelId: string }): Promise<{ session: Session }> {
		return this.call("session.setModel", args);
	}
	sessionSetAutoAccept(args: {
		sessionId: string;
		enabled: boolean;
	}): Promise<{ session: Session }> {
		return this.call("session.setAutoAccept", args);
	}
	permissionReply(args: {
		sessionId: string;
		requestId: string;
		decision: "once" | "always" | "reject";
		message?: string;
	}): Promise<Record<string, never>> {
		return this.call("permission.reply", args);
	}
	sessionSync(args: { sessionId: string; epoch?: string; afterSeq?: number }): Promise<SyncResult> {
		return this.call("session.sync", args);
	}
	sessionDiff(args: { sessionId: string }): Promise<{ files: FileDiff[] }> {
		return this.call("session.diff", args);
	}
	sessionChildren(args: { sessionId: string }): Promise<{ sessions: Session[] }> {
		return this.call("session.children", args);
	}
	backendModes(args: { backend?: string; workspaceId?: string } = {}): Promise<{ modes: Mode[] }> {
		return this.call("backend.modes", args);
	}
	backendModels(args: { backend?: string; workspaceId?: string } = {}): Promise<{ models: Model[] }> {
		return this.call("backend.models", args);
	}
}

/** Fan out one session's normalized events to whoever is watching (the SSE
 * bridge, one listener per open browser tab). Returns an unsubscribe. */
export function subscribeSessionEvents(
	deviceId: string,
	sessionId: string,
	listener: (envelope: Envelope) => void
): () => void {
	const state = registry.get(deviceId);
	if (!state) return () => {};
	let set = state.listeners.get(sessionId);
	if (!set) {
		set = new Set();
		state.listeners.set(sessionId, set);
	}
	set.add(listener);
	return () => {
		set?.delete(listener);
	};
}

function touchDeviceRow(deviceId: string, patch: Partial<CodeDevice>): void {
	void collections.codeDevices
		.updateOne({ _id: new ObjectId(deviceId) }, { $set: { ...patch, updatedAt: new Date() } })
		.catch((err) => logger.warn({ err, deviceId }, "machine link: device row update failed"));
}

/**
 * The connection's whole lifecycle, from the first frame after upgrade to
 * its close. Called once per accepted WebSocket, after `machineAuth` has
 * already validated the bearer (pre-upgrade, spec §3).
 */
export function acceptMachineConnection(
	ws: WebSocket,
	_req: IncomingMessage,
	principal: MachinePrincipal
): void {
	let helloReceived = false;
	const helloTimer = setTimeout(() => {
		if (!helloReceived) {
			try {
				ws.close(4000, "expected a hello frame");
			} catch {
				/* already gone */
			}
		}
	}, HELLO_TIMEOUT_MS);

	let state: ConnectionState | null = null;

	ws.on("message", (raw: Buffer | string) => {
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw.toString());
		} catch {
			return; // malformed JSON: ignored, not fatal (forward-compat rule)
		}
		const frame = parseMachineFrame(parsed);
		if (!frame) return;

		if (!helloReceived) {
			if (frame.type !== "hello") {
				ws.close(4000, "expected hello as the first frame");
				return;
			}
			helloReceived = true;
			clearTimeout(helloTimer);
			void onHello(ws, principal, frame).then((created) => {
				state = created;
			});
			return;
		}

		if (!state) return; // hello still being processed; frames before that are dropped
		switch (frame.type) {
			case "res": {
				const pending = state.pending.get(frame.id);
				if (!pending) return;
				clearTimeout(pending.timer);
				state.pending.delete(frame.id);
				if (frame.ok) pending.resolve(frame.result);
				else pending.reject(new OpError(frame.error.code, frame.error.message));
				return;
			}
			case "event": {
				const listeners = state.listeners.get(frame.sessionId);
				if (!listeners || listeners.size === 0) return;
				const envelope: Envelope = {
					sessionId: frame.sessionId,
					epoch: frame.epoch,
					seq: frame.seq,
					event: frame.event,
				};
				for (const listener of listeners) listener(envelope);
				return;
			}
			case "credential": {
				touchDeviceRow(state.deviceId, { credentialState: frame.state });
				return;
			}
			case "auth": {
				void revalidateMachineAuth(frame.token, state.principal.sub)
					.then((validated) => {
						if (!state) return;
						state.principal = { ...state.principal, exp: validated.exp, iss: validated.iss };
						scheduleAuthDeadline(state);
					})
					.catch((err) => {
						logger.warn({ err, deviceId: state?.deviceId }, "machine link: auth renewal rejected");
						if (state) closeConnection(state, 4401, "renewal token invalid");
					});
				return;
			}
			default:
				return;
		}
	});

	ws.on("pong", () => {
		if (state) state.lastPongAt = Date.now();
	});

	ws.on("close", () => {
		clearTimeout(helloTimer);
		if (state && registry.get(state.deviceId) === state) {
			if (state.authDeadline) clearTimeout(state.authDeadline);
			if (state.pingInterval) clearInterval(state.pingInterval);
			for (const pending of state.pending.values()) {
				clearTimeout(pending.timer);
				pending.reject(new OpError("unavailable", "The machine link closed."));
			}
			registry.delete(state.deviceId);
		}
	});

	ws.on("error", (err) => {
		logger.warn({ err }, "machine link: socket error");
	});
}

async function onHello(
	ws: WebSocket,
	principal: MachinePrincipal,
	hello: import("$lib/types/machineProtocol").HelloFrame
): Promise<ConnectionState | null> {
	const now = new Date();
	const existing = await collections.codeDevices.findOne({
		userId: principal.userId,
		machineId: principal.machineId,
	});

	if (existing?.status === "revoked") {
		try {
			ws.close(4403, "this machine was revoked");
		} catch {
			/* already gone */
		}
		return null;
	}

	let deviceId: string;
	let status: CodeDevice["status"];
	if (existing) {
		deviceId = existing._id.toHexString();
		status = existing.status;
		await collections.codeDevices.updateOne(
			{ _id: existing._id },
			{
				$set: {
					name: principal.machineName,
					sub: principal.sub,
					iss: principal.iss,
					backends: hello.backends,
					policy: hello.policy,
					credentialState: hello.credential.state,
					lastSeenAt: now,
					updatedAt: now,
				},
			}
		);
	} else {
		const inserted = await collections.codeDevices.insertOne({
			_id: new ObjectId(),
			userId: principal.userId,
			machineId: principal.machineId,
			name: principal.machineName,
			status: "pending",
			sub: principal.sub,
			iss: principal.iss,
			backends: hello.backends,
			policy: hello.policy,
			credentialState: hello.credential.state,
			lastSeenAt: now,
			createdAt: now,
			updatedAt: now,
		});
		deviceId = inserted.insertedId.toHexString();
		status = "pending";
	}

	// A newer connection for the same machine replaces an older one (§3).
	const previous = registry.get(deviceId);
	if (previous) closeConnection(previous, 4409, "a newer connection replaced this one");

	const state: ConnectionState = {
		deviceId,
		ws,
		principal,
		backends: hello.backends,
		policy: hello.policy,
		pending: new Map(),
		listeners: new Map(),
		authDeadline: null,
		pingInterval: null,
		lastPongAt: Date.now(),
	};
	registry.set(deviceId, state);
	scheduleAuthDeadline(state);
	state.pingInterval = setInterval(() => {
		if (Date.now() - state.lastPongAt > PONG_DEAD_AFTER_MS) {
			logger.warn({ deviceId }, "machine link: no pong within the dead-peer window, terminating");
			ws.terminate();
			return;
		}
		try {
			ws.ping();
		} catch {
			/* socket already going away */
		}
	}, PING_INTERVAL_MS);

	try {
		ws.send(JSON.stringify({ type: "welcome", deviceId, status }));
	} catch (err) {
		logger.warn({ err, deviceId }, "machine link: failed to send welcome");
	}
	return state;
}
